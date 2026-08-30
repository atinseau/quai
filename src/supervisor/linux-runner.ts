/**
 * The Linux implementation of the Runner seam.
 *
 * A project's process runs under its own UNIX account, inside its own network
 * namespace, and within its own cgroup. So the file isolation the prototype
 * validated applies to the running service, its listening port belongs to it
 * alone, and a runaway is contained without taking its neighbours down.
 *
 * A later ticket adds seccomp confinement to this same class. Nothing above
 * the seam changes when it lands.
 */

import { existsSync } from "node:fs";
import { mkdir, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountNameFor } from "./accounts";
import { DEFAULT_LIMITS, ProjectCgroup, type Limits } from "./cgroup";
import { containerCgroupPath } from "./cgroup-path";
import { EgressPolicy, natCommands, natInstallCommand } from "./egress";
import { LogBuffer } from "./logs";
import { buildJailArgs, resolveExecutable } from "./seccomp";
import { NetworkNamespace, allocateSubnet } from "./netns";
import type { RunHandle, RunSpec, RunState, Runner } from "./runner";

/** Where the rendered policy is written at startup. */
export const SECCOMP_POLICY_PATH = "/etc/quai/seccomp.policy";

/** Enough to diagnose a failed start without unbounded growth. */
const MAX_LOG_LINES = 500;

type Running = {
  handle: RunHandle;
  process: Bun.Subprocess;
  namespace: NetworkNamespace | null;
  cgroup: ProjectCgroup | null;
  logs: LogBuffer;
};

async function run(argv: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { ok: proc.exitCode === 0, stderr: stderr.trim() };
}

export class LinuxRunner implements Runner {
  private processes = new Map<string, Running>();
  private delegated = false;
  private natReady = false;

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

    // Syscall confinement wraps the project command itself, inside the uid
    // switch: nsjail must apply the filter to the project, not to setpriv.
    // nsjail execs directly and never consults PATH, so the executable has to
    // be resolved here or it fails with ENOENT.
    const [name, ...rest] = spec.command;
    const command = [resolveExecutable(name ?? "", existsSync), ...rest];

    const confined =
      spec.confineSyscalls === false
        ? command
        : buildJailArgs({
            policyPath: SECCOMP_POLICY_PATH,
            command,
            cwd: spec.home,
            env: environment,
          });

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
      ...confined,
    ];

    // Entering the namespace happens before dropping privileges: it needs
    // NET_ADMIN, which the project itself must never hold.
    return namespace === null ? launch : namespace.wrapCommand(launch);
  }

  /**
   * Enables the controllers Quai needs on the container's subtree, once.
   *
   * The supervisor steps into a leaf of its own first: a cgroup cannot both
   * hold processes and delegate controllers to its children.
   */
  private async ensureDelegation(cgroup: ProjectCgroup): Promise<void> {
    if (this.delegated) return;

    await mkdir(cgroup.supervisorLeaf, { recursive: true });
    await writeFile(join(cgroup.supervisorLeaf, "cgroup.procs"), String(process.pid)).catch(
      () => {},
    );

    const write = cgroup.delegationWrite();
    await writeFile(join(cgroup.containerCgroup, write.file), write.value);
    this.delegated = true;
  }

  /** Builds the project's cgroup and applies its limits. */
  private async createCgroup(spec: RunSpec): Promise<ProjectCgroup> {
    const cgroup = new ProjectCgroup(await containerCgroupPath(), spec.project);
    await this.ensureDelegation(cgroup);
    await mkdir(cgroup.path, { recursive: true });

    for (const write of cgroup.limitWrites(spec.limits ?? DEFAULT_LIMITS)) {
      // swap control is absent on some kernels; the memory cap still holds.
      await writeFile(join(cgroup.path, write.file), write.value).catch((error) => {
        if (write.file !== "memory.swap.max") throw error;
      });
    }

    return cgroup;
  }

  /**
   * Enables masquerading once, so projects can reach the public internet.
   *
   * The rule is checked before being added: without that, every restart would
   * append a duplicate.
   */
  private async ensureNat(): Promise<void> {
    if (this.natReady) return;

    const [forward, check] = natCommands();
    await run(forward!);
    const exists = await run(check!);
    if (!exists.ok) await run(natInstallCommand());
    this.natReady = true;
  }

  /** Builds the project's namespace, replacing any leftover of the same name. */
  private async createNamespace(spec: RunSpec): Promise<NetworkNamespace> {
    const namespace = new NetworkNamespace(
      spec.project,
      allocateSubnet(spec.namespaceIndex ?? 0),
      spec.internalPort,
    );

    await this.ensureNat();

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

    await this.applyEgressPolicy(namespace);
    return namespace;
  }

  /**
   * Fences the project in: the internet stays open, neighbours and the
   * operator's private network do not.
   *
   * A namespace that cannot be fenced is torn down rather than left running,
   * since a project reaching its neighbours is worse than one that fails to
   * start.
   */
  private async applyEgressPolicy(namespace: NetworkNamespace): Promise<void> {
    const policy = new EgressPolicy(
      namespace.name,
      namespace.subnet,
      "qh-" + namespace.project,
    );

    for (const rule of policy.rules()) {
      const result = await run(rule);
      if (!result.ok) {
        await run(namespace.destroyCommands()[0]!);
        throw new Error(
          "Could not fence project '" + namespace.project + "': " + result.stderr,
        );
      }
    }
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    if (spec.uid === 0) {
      throw new Error(`Refusing to run project '${spec.project}' as root`);
    }

    const namespace = spec.isolateNetwork === false ? null : await this.createNamespace(spec);
    const cgroup = spec.limitResources === false ? null : await this.createCgroup(spec);

    const child = Bun.spawn(this.buildArgv(spec, namespace), {
      cwd: spec.home,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (child.pid === undefined) {
      if (namespace) await run(namespace.destroyCommands()[0]!);
      throw new Error(`Could not start project '${spec.project}'`);
    }

    // Moving the pid in after spawn is what actually enforces the limits; the
    // cgroup files alone constrain nothing until a process lives there.
    if (cgroup !== null) {
      const attach = cgroup.attachWrite(child.pid);
      await writeFile(join(cgroup.path, attach.file), attach.value).catch(() => {});
    }

    const handle: RunHandle = {
      project: spec.project,
      pid: child.pid,
      port: spec.internalPort,
      // Requests reach the service at its own end of the veth pair.
      address: namespace?.subnet.projectAddress ?? "127.0.0.1",
    };
    const logs = new LogBuffer(MAX_LOG_LINES);
    this.captureOutput(child, logs);

    this.processes.set(spec.project, { handle, process: child, namespace, cgroup, logs });
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
    // A cgroup is a kernel directory: rmdir removes it, a recursive rm does not.
    if (running.cgroup) await rmdir(running.cgroup.path).catch(() => {});
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

  /**
   * Drains a project's output into its buffer.
   *
   * Reading continuously matters: an unread pipe fills and blocks the project
   * once it has written enough.
   */
  private captureOutput(child: Bun.Subprocess, logs: LogBuffer): void {
    for (const stream of [child.stdout, child.stderr]) {
      if (!(stream instanceof ReadableStream)) continue;

      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          logs.append(decoder.decode(chunk as Uint8Array, { stream: true }));
        }
      })().catch(() => {});
    }
  }

  /** Recent output of a project, or null when it is not running. */
  logs(project: string): string | null {
    return this.processes.get(project)?.logs.read() ?? null;
  }
}

export type { Limits };

