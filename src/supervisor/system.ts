/**
 * Reads the isolation facts from the running system.
 *
 * This is the impure edge: every format it reads is parsed by the pure
 * functions in parsers.ts, and the one guarantee that cannot be established by
 * reading — cgroup delegation — is established by attempting it for real.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DelegationOutcome, SystemProbe } from "./preflight";
import { decodeCapabilities, findMountFor, parseCgroupPath } from "./parsers";

const CGROUP_ROOT = "/sys/fs/cgroup";

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Reads the capabilities the process can actually exercise, not merely hold. */
function effectiveCapabilities(status: string): string[] {
  const line = status.split("\n").find((l) => l.startsWith("CapEff:"));
  return decodeCapabilities(line?.split(/\s+/)[1] ?? "");
}

/**
 * Proves that controllers can be delegated to a child cgroup, by doing it.
 *
 * No static reading establishes this. A cgroup cannot both hold processes and
 * delegate controllers to its children — the "no internal process" rule — so
 * the supervisor first steps into a leaf of its own, then enables the
 * controllers, then confirms a child cgroup accepts a limit.
 */
export async function attemptDelegation(cgroupPath: string): Promise<DelegationOutcome> {
  const base = join(CGROUP_ROOT, cgroupPath);

  try {
    await mkdir(join(base, "quai-supervisor"), { recursive: true });
    await writeFile(join(base, "quai-supervisor", "cgroup.procs"), String(process.pid));
    await writeFile(join(base, "cgroup.subtree_control"), "+memory +cpu +pids");

    const probe = join(base, "quai-preflight");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "memory.max"), "67108864");
    const readBack = (await read(join(probe, "memory.max"))).trim();

    if (readBack !== "67108864") {
      return {
        attempted: true,
        succeeded: false,
        detail: `memory.max did not hold its value (read back "${readBack}")`,
      };
    }

    return { attempted: true, succeeded: true, detail: "delegated memory, cpu and pids" };
  } catch (error) {
    return {
      attempted: true,
      succeeded: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Gathers every fact the preflight judges. */
export async function readSystem(homesPath: string): Promise<SystemProbe> {
  const [selfCgroup, controllers, mounts, status] = await Promise.all([
    read("/proc/self/cgroup"),
    read(join(CGROUP_ROOT, "cgroup.controllers")),
    read("/proc/mounts"),
    read("/proc/self/status"),
  ]);

  const cgroupPath = parseCgroupPath(selfCgroup);
  const cgroupMount = findMountFor(mounts, CGROUP_ROOT);
  const homesMount = findMountFor(mounts, homesPath);
  const cgroupWritable = cgroupMount.options.split(",").includes("rw");

  // Only worth attempting once the prerequisites are in place; otherwise the
  // failure would just restate what the static checks already report.
  const canAttempt = cgroupPath !== "/" && cgroupWritable;
  const cgroupDelegation = canAttempt
    ? await attemptDelegation(cgroupPath)
    : {
        attempted: false,
        succeeded: false,
        detail: "skipped because the cgroup namespace or mount is unusable",
      };

  return {
    cgroupNamespace: cgroupPath === "/" ? "private" : "host",
    cgroupControllers: controllers.trim().split(/\s+/).filter(Boolean),
    cgroupWritable,
    cgroupDelegation,
    homesFilesystem: homesMount.type.toLowerCase(),
    projectQuotasEnabled: homesMount.options.split(",").includes("prjquota"),
    capabilities: effectiveCapabilities(status),
  };
}

/** Asks each runtime for its version; a runtime that cannot answer reports null. */
export async function readRuntimes(): Promise<{ name: string; version: string | null }[]> {
  const probes: [string, string[]][] = [
    ["node", ["node", "-v"]],
    ["python", ["python3", "-V"]],
    ["bun", ["bun", "-v"]],
  ];

  return Promise.all(
    probes.map(async ([name, argv]) => {
      try {
        const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
        const out = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        return { name, version: proc.exitCode === 0 && out ? out : null };
      } catch {
        return { name, version: null };
      }
    }),
  );
}

