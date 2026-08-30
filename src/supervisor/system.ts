/**
 * Reads the host facts from /proc and /sys. This is the impure edge that feeds
 * the pure probe parser; everything testable lives in probe.ts.
 */

import { readFile } from "node:fs/promises";
import { statfs } from "node:fs/promises";
import type { RawSystemReadings } from "./probe";

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Finds the mount options for a mount point in /proc/mounts. */
async function mountOptionsFor(target: string): Promise<{ type: string; options: string }> {
  const mounts = await read("/proc/mounts");
  for (const line of mounts.split("\n")) {
    const [, mountPoint, type, options] = line.split(/\s+/);
    if (mountPoint === target) return { type: type ?? "", options: options ?? "" };
  }
  return { type: "", options: "" };
}

/** Capabilities are exposed as a hex bitmask; decode the ones we require. */
const CAPABILITY_BITS: Record<string, bigint> = {
  NET_ADMIN: 1n << 12n,
  SYS_ADMIN: 1n << 21n,
};

async function boundingSet(): Promise<string[]> {
  const status = await read("/proc/self/status");
  const line = status.split("\n").find((l) => l.startsWith("CapBnd:"));
  if (!line) return [];
  const mask = BigInt("0x" + (line.split(/\s+/)[1] ?? "0"));
  return Object.entries(CAPABILITY_BITS)
    .filter(([, bit]) => (mask & bit) !== 0n)
    .map(([name]) => name);
}

export async function readSystem(homesPath: string): Promise<RawSystemReadings> {
  const [selfCgroup, cgroupControllers, cgroupMount, homesMount, capabilityBoundingSet] =
    await Promise.all([
      read("/proc/self/cgroup"),
      read("/sys/fs/cgroup/cgroup.controllers"),
      mountOptionsFor("/sys/fs/cgroup"),
      mountOptionsFor(homesPath),
      boundingSet(),
    ]);

  return {
    selfCgroup,
    cgroupControllers,
    cgroupMountOptions: cgroupMount.options,
    homesFilesystemType: homesMount.type,
    homesMountOptions: homesMount.options,
    capabilityBoundingSet,
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

