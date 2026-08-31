/**
 * Outbound traffic policy.
 *
 * Network namespaces gave each project its own stack, but a stack still routes:
 * a project could reach a neighbour by aiming at its veth address, and reach
 * the operator's private network the same way. These rules close that.
 *
 * The shape is deliberate. Most applications need to call public APIs, so the
 * internet stays open; none needs to explore the infrastructure hosting it, so
 * private ranges are refused.
 */

import type { Subnet } from "./netns";

/** Ranges a project has no business reaching. */
export const PRIVATE_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16", // link-local, which is where cloud metadata services live
] as const;

/**
 * Commands run once on the supervisor side so projects can reach the internet.
 *
 * Without NAT a project's packets leave with a 10.83 source address that
 * nothing on the internet can answer: the route exists, but every reply is
 * lost. Masquerading rewrites the source to the container's own address.
 */
export function natCommands(): string[][] {
  return [
    ["sysctl", "-w", "net.ipv4.ip_forward=1"],
    [
      "iptables",
      "-t",
      "nat",
      "-C",
      "POSTROUTING",
      "-s",
      "10.83.0.0/16",
      "!",
      "-o",
      "qh-+",
      "-j",
      "MASQUERADE",
    ],
  ];
}

/** The rule that installs masquerading, applied when the check above fails. */
export function natInstallCommand(): string[] {
  return [
    "iptables",
    "-t",
    "nat",
    "-A",
    "POSTROUTING",
    "-s",
    "10.83.0.0/16",
    "!",
    "-o",
    "qh-+",
    "-j",
    "MASQUERADE",
  ];
}

export class EgressPolicy {
  constructor(
    private readonly namespace: string,
    readonly subnet: Subnet,
    private readonly hostInterface: string,
  ) {}

  private inNamespace(...rule: string[]): string[] {
    return ["ip", "netns", "exec", this.namespace, "iptables", ...rule];
  }

  /**
   * The rules, in the order they must be installed.
   *
   * Order carries meaning: iptables takes the first match, so every exception
   * has to precede the blocks it carves out of.
   */
  rules(): string[][] {
    return [
      // A project's own components may talk over its private loopback.
      this.inNamespace("-A", "OUTPUT", "-d", "127.0.0.0/8", "-j", "ACCEPT"),

      // The supervisor's end of the veth pair: the router proxies requests
      // over this link, so blocking it would cut the project off entirely.
      this.inNamespace("-A", "OUTPUT", "-d", this.subnet.hostAddress + "/32", "-j", "ACCEPT"),

      // DNS must survive, or nothing resolves and the open internet is useless.
      this.inNamespace("-A", "OUTPUT", "-p", "udp", "--dport", "53", "-j", "ACCEPT"),
      this.inNamespace("-A", "OUTPUT", "-p", "tcp", "--dport", "53", "-j", "ACCEPT"),

      // The Quai veth range: this is what stops a project from reaching a
      // neighbour directly.
      this.inNamespace("-A", "OUTPUT", "-d", "10.83.0.0/16", "-j", "REJECT"),

      // The operator's own network, including cloud metadata endpoints.
      ...PRIVATE_RANGES.map((range) =>
        this.inNamespace("-A", "OUTPUT", "-d", range, "-j", "REJECT"),
      ),
    ];
  }
}
