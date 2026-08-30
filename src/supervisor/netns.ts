/**
 * Per-project network namespaces.
 *
 * This is what makes app.listen(8080) work unmodified: each project gets its
 * own network stack, so its 8080 is not the neighbour's 8080 and not the
 * supervisor's either. The prototype measured the alternative — on a shared
 * loopback a project scans its neighbours' ports and reads their data.
 *
 * The namespace is joined to the supervisor by a veth pair on a /30, which
 * gives exactly two usable addresses: one per end.
 */

export type Subnet = {
  hostAddress: string;
  projectAddress: string;
  prefixLength: number;
};

/** The namespace backing a project. */
export function namespaceNameFor(project: string): string {
  return "quai-" + project;
}

/** Interface names are capped at 15 characters by the kernel. */
function interfaceNameFor(project: string, side: "h" | "p"): string {
  return ("q" + side + "-" + project).slice(0, 15);
}

/**
 * Carves a /30 out of 10.83.0.0/16 for the given project index.
 *
 * Deterministic on purpose: a restart must rebuild exactly the same wiring
 * from the database rather than reshuffle every project's address.
 */
export function allocateSubnet(index: number): Subnet {
  const block = index * 4;
  const third = Math.floor(block / 256) % 256;
  const fourth = block % 256;

  return {
    hostAddress: `10.83.${third}.${fourth + 1}`,
    projectAddress: `10.83.${third}.${fourth + 2}`,
    prefixLength: 30,
  };
}

export class NetworkNamespace {
  readonly name: string;

  constructor(
    readonly project: string,
    readonly subnet: Subnet,
    readonly internalPort: number,
  ) {
    this.name = namespaceNameFor(project);
  }

  private get hostInterface(): string {
    return interfaceNameFor(this.project, "h");
  }

  private get projectInterface(): string {
    return interfaceNameFor(this.project, "p");
  }

  /** The commands that build the namespace and its link to the supervisor. */
  createCommands(): string[][] {
    const mask = "/" + this.subnet.prefixLength;

    return [
      ["ip", "netns", "add", this.name],
      // A veth pair is the wire: one end stays here, the other moves inside.
      ["ip", "link", "add", this.hostInterface, "type", "veth", "peer", "name", this.projectInterface],
      ["ip", "link", "set", this.projectInterface, "netns", this.name],
      ["ip", "addr", "add", this.subnet.hostAddress + mask, "dev", this.hostInterface],
      ["ip", "link", "set", this.hostInterface, "up"],
      // Loopback is down by default in a fresh namespace, so a service binding
      // 127.0.0.1 would fail without this.
      ["ip", "netns", "exec", this.name, "ip", "link", "set", "lo", "up"],
      ["ip", "netns", "exec", this.name, "ip", "addr", "add", this.subnet.projectAddress + mask, "dev", this.projectInterface],
      ["ip", "netns", "exec", this.name, "ip", "link", "set", this.projectInterface, "up"],
      // Default route out through the supervisor end.
      ["ip", "netns", "exec", this.name, "ip", "route", "add", "default", "via", this.subnet.hostAddress],
    ];
  }

  /** Removing the namespace also removes the veth pair with it. */
  destroyCommands(): string[][] {
    return [["ip", "netns", "del", this.name]];
  }

  /** Runs a command inside this namespace. */
  wrapCommand(command: string[]): string[] {
    return ["ip", "netns", "exec", this.name, ...command];
  }
}

