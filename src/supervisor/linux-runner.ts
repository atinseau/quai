/**
 * The Linux implementation of the Runner seam.
 *
 * A project's process runs under its own UNIX account and inside its own
 * network namespace, so the file isolation the prototype validated applies to
 * the running service, and its listening port belongs to it alone.
 *
 * Later tickets extend this same class with cgroup limits and seccomp
 * confinement. Nothing above the seam changes when they land.
 */

import { accountNameFor } from "./accounts";
import { NetworkNamespace, allocateSubnet } from "./netns";
import type { RunHandle, RunSpec, RunState, Runner } from "./runner";

type Running = {
  handle: RunHandle;
  process: Bun.Subprocess;
  namespace: NetworkNamespace | null;
};

async function run(argv: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { ok: proc.exitCode === 0, stderr: stderr.trim() };
}

export class LinuxRunner implements Runner {
  private processes = new Map<string, Running>();

  /** Builds the argv that drops to the project's account before exec. */
  protected buildArgv(spec: RunSpec, namespace: NetworkNamespace | null): string[] {
    const environment = {
      ...spec.env,
      HOME: spec.home,
      PORT: String(spec.internalPort),
      USER: accountNameFor(spec.project),
      PATH: "/usr/local/bin:/usr/bin:/bin",
    };

    // setpriv resets HOME and USER when it changes uid, so the environment has
    // to be applied after the switch rather than inherited through it.
    const envArgs = Object.entries(environment).map(([key, value]) => `${key}=${value}`);

    const launch = [
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

    // Entering the namespace happens before dropping privileges: it needs
    // NET_ADMIN, which the project itself must never hold.
    return namespace === null ? launch : namespace.wrapCommand(launch);
  }

  /** Builds the project's namespace, replacing any leftover of the same name. */
  private async createNamespace(spec: RunSpec): Promise<NetworkNamespace> {
    const namespace = new NetworkNamespace(
      spec.project,
      allocateSubnet(spec.namespaceIndex ?? 0),
      spec.internalPort,
    );

    // A previous run may have left one behind; deleting first keeps a restart
    // from failing on a name that already exists.
    await run(namespace.destroyCommands()[0]!);

    for (const command of namespace.createCommands()) {
      const result = await run(command);
      if (!result.ok) {
        await run(namespace.destroyCommands()[0]!);
        throw new Error(
          `Could not build the network namespace for '${spec.project}': ${result.stderr}`,
        );
      }
    }

    return namespace;
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    if (spec.uid === 0) {
      throw new Error(`Refusing to run project '${spec.project}' as root`);
    }

    const namespace = spec.isolateNetwork === false ? null : await this.createNamespace(spec);

    const child = Bun.spawn(this.buildArgv(spec, namespace), {
      cwd: spec.home,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (child.pid === undefined) {
      if (namespace) await run(namespace.destroyCommands()[0]!);
      throw new Error(`Could not start project '${spec.project}'`);
    }

    const handle: RunHandle = {
      project: spec.project,
      pid: child.pid,
      port: spec.internalPort,
      // Requests reach the service at its own end of the veth pair.
      address: namespace?.subnet.projectAddress ?? "127.0.0.1",
    };
    this.processes.set(spec.project, { handle, process: child, namespace });
    return handle;
  }

  async stop(project: string): Promise<void> {
    const running = this.processes.get(project);
    if (running === undefined) return;

    this.processes.delete(project);
    running.process.kill();
    await running.process.exited;

    // Removing the namespace takes the veth pair with it, so nothing leaks
    // between deploys.
    if (running.namespace) await run(running.namespace.destroyCommands()[0]!);
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

  /** Where a running project can be reached, or null when it is not running. */
  addressFor(project: string): string | null {
    return this.processes.get(project)?.handle.address ?? null;
  }

  /** Reads whatever the project has written to stdout and stderr so far. */
  streamsFor(project: string): Bun.Subprocess | null {
    return this.processes.get(project)?.process ?? null;
  }
}

