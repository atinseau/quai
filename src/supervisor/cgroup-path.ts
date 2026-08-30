/**
 * The container's own cgroup, resolved once.
 *
 * Both the preflight and the runner need it, and both relocate the supervisor
 * into a leaf to satisfy the "no internal process" rule. Reading
 * /proc/self/cgroup after either has moved yields the leaf rather than the
 * container root, so a second reader would nest everything one level deeper.
 * Resolving once, before anything moves, is what keeps every project a sibling
 * under the same parent.
 */

import { readFile } from "node:fs/promises";

const CGROUP_ROOT = "/sys/fs/cgroup";

let resolved: string | null = null;

/** Extracts the cgroup v2 path from a /proc/self/cgroup body. */
export function parseOwnCgroup(contents: string): string {
  const line = contents.split("\n").find((l) => l.startsWith("0::"));
  return line === undefined ? "/" : (line.slice("0::".length).trim() || "/");
}

/**
 * Strips any leaf this process was moved into, recovering the container root.
 *
 * Idempotent on purpose: calling it after a relocation must give the same
 * answer as calling it before.
 */
export function containerRootOf(cgroupPath: string): string {
  const segments = cgroupPath.split("/").filter(Boolean);
  while (segments.length > 0 && segments[segments.length - 1]!.startsWith("quai-")) {
    segments.pop();
  }
  return "/" + segments.join("/");
}

/** The absolute path of the container's cgroup, cached for the process. */
export async function containerCgroupPath(): Promise<string> {
  if (resolved !== null) return resolved;

  const contents = await readFile("/proc/self/cgroup", "utf8").catch(() => "");
  const root = containerRootOf(parseOwnCgroup(contents));
  resolved = root === "/" ? CGROUP_ROOT : CGROUP_ROOT + root;
  return resolved;
}

/** Test seam: forgets the cached value. */
export function resetContainerCgroupCache(): void {
  resolved = null;
}

