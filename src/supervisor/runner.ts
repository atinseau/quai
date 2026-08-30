/**
 * The Runner seam.
 *
 * Every piece of system machinery that isolates a project — UNIX account,
 * cgroup, network namespace, seccomp confinement — lives behind this one
 * interface. It is the only contact point between the supervisor and the
 * kernel, which is what will allow a micro-VM implementation to replace it
 * later without touching the CLI, the router, or any test above this line.
 */

export type RunSpec = {
  project: string;
  /** The project's own uid. Never 0: a project must not run as root. */
  uid: number;
  home: string;
  command: string[];
  /** The port the process listens on inside its own namespace. */
  internalPort: number;
  env: Record<string, string>;
  /** Position used to derive the project's veth subnet. */
  namespaceIndex?: number;
  /** Set false only where namespaces are unavailable, such as in tests. */
  isolateNetwork?: boolean;
  /** Resource ceilings; defaults apply when absent. */
  limits?: { memory: string; cpu: string; pids: number };
  /** Set false only where cgroups are unavailable, such as in tests. */
  limitResources?: boolean;
  /** Set false only where nsjail is unavailable, such as in tests. */
  confineSyscalls?: boolean;
};

export type RunHandle = {
  project: string;
  pid: number;
  port: number;
  /** Where the supervisor reaches this project. */
  address?: string;
};

export type RunState =
  | { state: "running"; pid: number }
  | { state: "stopped" }
  | { state: "crashed"; pid?: number };

export interface Runner {
  start(spec: RunSpec): Promise<RunHandle>;
  stop(project: string): Promise<void>;
  status(project: string): Promise<RunState>;
}

/**
 * Tracks what should be running and answers what actually is.
 *
 * The distinction matters: a project the supervisor started but that the
 * runner no longer reports has crashed, and saying so is what lets an operator
 * tell a dead service from one that was never deployed.
 */
export class ProjectSupervisor {
  /** Projects this supervisor has started and not deliberately stopped. */
  private expected = new Map<string, RunHandle>();

  constructor(private readonly runner: Runner) {}

  async start(spec: RunSpec): Promise<RunHandle> {
    if (spec.uid === 0) {
      throw new Error(`Refusing to run project '${spec.project}' as root`);
    }

    // Replace rather than accumulate: redeploying must not leave the previous
    // process holding the port.
    if (this.expected.has(spec.project)) {
      await this.runner.stop(spec.project);
      this.expected.delete(spec.project);
    }

    const handle = await this.runner.start(spec);
    this.expected.set(spec.project, handle);
    return handle;
  }

  async stop(project: string): Promise<void> {
    if (!this.expected.has(project)) return;
    this.expected.delete(project);
    await this.runner.stop(project);
  }

  async stopAll(): Promise<void> {
    for (const project of [...this.expected.keys()]) {
      // One failure must not strand the rest.
      await this.stop(project).catch(() => {});
    }
  }

  async status(project: string): Promise<RunState> {
    const actual = await this.runner.status(project);

    if (actual.state === "stopped" && this.expected.has(project)) {
      return { state: "crashed", pid: this.expected.get(project)?.pid };
    }

    return actual;
  }

  running(): string[] {
    return [...this.expected.keys()];
  }
}

