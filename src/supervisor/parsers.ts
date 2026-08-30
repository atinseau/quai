/**
 * Pure parsers for the /proc formats the preflight depends on.
 *
 * These live apart from the reading so they can be tested against real-world
 * shapes — hybrid cgroup files, nested mounts, escaped mount points — without
 * a container.
 */

export type MountEntry = {
  type: string;
  options: string;
};

/** /proc/mounts escapes spaces, tabs, newlines and backslashes as octal. */
function unescapeMountPath(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

/** True when `path` is `mountPoint` itself or sits inside it. */
function isUnder(path: string, mountPoint: string): boolean {
  if (path === mountPoint) return true;
  if (mountPoint === "/") return path.startsWith("/");
  return path.startsWith(mountPoint + "/");
}

/**
 * Finds the mount actually carrying `target`.
 *
 * The longest matching mount point wins, because QUAI_HOMES usually sits
 * inside its volume rather than being the volume itself, and a nested mount
 * must take precedence over its ancestor.
 */
export function findMountFor(mountTable: string, target: string): MountEntry {
  let best: (MountEntry & { length: number }) | null = null;

  for (const line of mountTable.split("\n")) {
    const fields = line.split(/\s+/);
    if (fields.length < 4) continue;
    const mountPoint = unescapeMountPath(fields[1] ?? "");
    if (!isUnder(target, mountPoint)) continue;
    if (best === null || mountPoint.length > best.length) {
      best = { type: fields[2] ?? "", options: fields[3] ?? "", length: mountPoint.length };
    }
  }

  return best ? { type: best.type, options: best.options } : { type: "", options: "" };
}

/**
 * Extracts the cgroup v2 path from /proc/self/cgroup.
 *
 * Hybrid hosts also list v1 controller lines; only the "0::" line describes
 * the unified hierarchy, and reading any other line would misjudge the
 * container's position in the tree.
 */
export function parseCgroupPath(contents: string): string {
  for (const line of contents.split("\n")) {
    if (!line.startsWith("0::")) continue;
    return line.slice("0::".length).trim() || "/";
  }
  return "/";
}

/** Capability bit positions, per linux/capability.h. */
const CAPABILITY_BITS: Record<string, bigint> = {
  NET_ADMIN: 1n << 12n,
  SYS_ADMIN: 1n << 21n,
};

/**
 * Decodes the capabilities Quai requires from a hex mask as found in
 * /proc/self/status.
 */
export function decodeCapabilities(hexMask: string): string[] {
  const cleaned = hexMask.trim();
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return [];

  const mask = BigInt("0x" + cleaned);
  return Object.entries(CAPABILITY_BITS)
    .filter(([, bit]) => (mask & bit) !== 0n)
    .map(([name]) => name);
}

