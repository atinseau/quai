import { decideRestart, type RestartHistory } from "./restart-policy";

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
  /** Recent output, or null when the project is not running. */
  logs?(project: string): string | null;
  /** Persisted output, readable even for a project that is not running. */
  logsFromDisk?(project: string): Promise<string | null>;
  /** Discards a project's persisted output. */
  removeLogs?(project: string): Promise<void>;
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
  /** What each project was started with, so a crash can be undone. */
  private specs = new Map<string, RunSpec>();
  /** Crash record per project, which is what the restart policy reads. */
  private history = new Map<string, RestartHistory>();
  /** Projects the policy gave up on; only a deploy brings them back. */
  private abandoned = new Set<string>();

  constructor(
    private readonly runner: Runner,
    /** Injected so backoff behaviour can be tested without waiting. */
    private readonly clock: () => number = Date.now,
  ) {}

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
    this.specs.set(spec.project, spec);

    // A deploy is the operator saying the project is fixed, so its crash
    // record starts over.
    this.abandoned.delete(spec.project);
    this.history.set(spec.project, {
      failures: 0,
      lastStartedAt: this.clock(),
      lastFailedAt: 0,
      lastUptimeMs: 0,
    });

    return handle;
  }

  async stop(project: string): Promise<void> {
    if (!this.expected.has(project)) return;
    this.expected.delete(project);
    // Deliberately stopped: nothing should bring it back.
    this.specs.delete(project);
    this.history.delete(project);
    this.abandoned.delete(project);
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

  /**
   * Restarts projects that stopped on their own.
   *
   * Called on a timer by the supervisor. A crash is undone rather than merely
   * reported: without this a passing out-of-memory kill retires a project
   * until someone redeploys by hand.
   *
   * @param clock injected so the backoff can be tested without waiting.
   * @param onAbandon told about projects the policy has given up on.
   */
  async reviveCrashed(
    clock: () => number = this.clock,
    onAbandon?: (project: string, reason: string) => void,
  ): Promise<void> {
    for (const project of [...this.expected.keys()]) {
      if (this.abandoned.has(project)) continue;

      const actual = await this.runner.status(project);
      if (actual.state === "running") continue;

      const spec = this.specs.get(project);
      if (spec === undefined) continue;

      const now = clock();
      const previous = this.history.get(project) ?? {
        failures: 0,
        lastStartedAt: now,
        lastFailedAt: 0,
        lastUptimeMs: 0,
      };

      // A failure is recorded once, on the pass that first notices the project
      // is down. Later passes only wait out the backoff, so the uptime already
      // captured must not be recomputed: the waiting time would read as uptime
      // and clear the failure count, restarting a broken project forever.
      const alreadyRecorded = previous.lastFailedAt !== 0;
      const record: RestartHistory = alreadyRecorded
        ? previous
        : {
            ...previous,
            lastFailedAt: now,
            lastUptimeMs: now - previous.lastStartedAt,
          };
      this.history.set(project, record);

      const decision = decideRestart(record, now);

      if (decision.action === "give-up") {
        this.abandoned.add(project);
        onAbandon?.(project, decision.reason);
        continue;
      }

      if (decision.action === "wait") {
        this.history.set(project, record);
        continue;
      }

      try {
        const handle = await this.runner.start(spec);
        this.expected.set(project, handle);
        // Counted before the restart, so a project that dies instantly climbs
        // the backoff instead of spinning.
        this.history.set(project, {
          failures: record.failures + 1,
          lastStartedAt: now,
          // Cleared so the next failure is recorded afresh, measuring uptime
          // from this restart rather than from the original one.
          lastFailedAt: 0,
          lastUptimeMs: 0,
        });
      } catch {
        // One project failing to restart must not stop the others.
        this.history.set(project, { ...record, failures: record.failures + 1 });
      }
    }
  }

  /** Projects the restart policy has given up on. */
  givenUp(): string[] {
    return [...this.abandoned];
  }

  /** Recent output of a project, or null when it is not running. */
  logsFor(project: string): string | null {
    return this.runner.logs?.(project) ?? null;
  }

  /**
   * Output of a project, from disk when it is not running.
   *
   * A crashed project is exactly the one whose logs are wanted, so falling
   * back to the file rather than returning nothing is the point.
   */
  async logsIncludingStopped(project: string): Promise<string | null> {
    const live = this.runner.logs?.(project);
    if (live !== null && live !== undefined && live.length > 0) return live;
    return (await this.runner.logsFromDisk?.(project)) ?? live ?? null;
  }

  /** Discards a project's persisted output, when it is deleted. */
  async discardLogs(project: string): Promise<void> {
    await this.runner.removeLogs?.(project);
  }

  running(): string[] {
    return [...this.expected.keys()];
  }
}
