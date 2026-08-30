/**
 * The Linux implementation of the Runner seam.
 *
 * Launches a project's process under its own UNIX account, so the file
 * isolation the prototype validated applies to the running service: a project
 * can neither read, list nor write another's home.
 *
 * Later tickets extend this same class with a network namespace, cgroup limits
 * and seccomp confinement. Nothing above the seam changes when they land.
 */

import { accountNameFor } from "./accounts";
import type { RunHandle, RunSpec, RunState, Runner } from "./runner";

type Running = {
  handle: RunHandle;
  process: Bun.Subprocess;
  /** Set when stop() asked for it, to tell a clean stop from a crash. */
  stopping: boolean;
};

export class LinuxRunner implements Runner {
  private processes = new Map<string, Running>();

  /** Builds the argv that drops to the project's account before exec. */
  protected buildArgv(spec: RunSpec): string[] {
    const environment = {
      ...spec.env,
      HOME: spec.home,
      PORT: String(spec.internalPort),
      USER: accountNameFor(spec.project),
      PATH: "/usr/local/bin:/usr/bin:/bin",
    };

    // setpriv resets HOME and USER when it changes uid, so the environment has
    // to be applied after the switch rather than inherited through it.
    const envArgs = Object.entries(environment).flatMap(([key, value]) => [
      `${key}=${value}`,
    ]);

    return [
      "setpriv",
      "--reuid",
      String(spec.uid),
      "--regid",
      String(spec.uid),
      "--clear-groups",
      "--",
      "env",
      ...envArgs,
      ...spec.command,
    ];
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    if (spec.uid === 0) {
      throw new Error(`Refusing to run project '${spec.project}' as root`);
    }

    const child = Bun.spawn(this.buildArgv(spec), {
      cwd: spec.home,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (child.pid === undefined) {
      throw new Error(`Could not start project '${spec.project}'`);
    }

    const handle: RunHandle = {
      project: spec.project,
      pid: child.pid,
      port: spec.internalPort,
    };
    this.processes.set(spec.project, { handle, process: child, stopping: false });
    return handle;
  }

  async stop(project: string): Promise<void> {
    const running = this.processes.get(project);
    if (running === undefined) return;

    running.stopping = true;
    this.processes.delete(project);
    running.process.kill();
    await running.process.exited;
  }

  async status(project: string): Promise<RunState> {
    const running = this.processes.get(project);
    if (running === undefined) return { state: "stopped" };

    // exitCode is null while the process is alive; anything else means it is
    // gone, and since stop() removes the entry, that can only be a crash.
    if (running.process.exitCode !== null || running.process.signalCode !== null) {
      this.processes.delete(project);
      return { state: "crashed", pid: running.handle.pid };
    }

    return { state: "running", pid: running.handle.pid };
  }

  /** Reads whatever the project has written to stdout and stderr so far. */
  streamsFor(project: string): Bun.Subprocess | null {
    return this.processes.get(project)?.process ?? null;
  }
}

