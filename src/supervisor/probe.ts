/**
 * Reads the isolation-relevant facts about the host, so the preflight can
 * judge them. Parsing is kept separate from reading: the parsing is pure and
 * fully testable, while the reading touches /proc and /sys.
 */

import type { SystemProbe } from "./preflight";

/** Raw strings as read from /proc and /sys, before interpretation. */
export type RawSystemReadings = {
  /** Contents of /proc/self/cgroup. */
  selfCgroup: string;
  /** Contents of /sys/fs/cgroup/cgroup.controllers. */
  cgroupControllers: string;
  /** Mount options for /sys/fs/cgroup. */
  cgroupMountOptions: string;
  /** Filesystem type backing the project homes. */
  homesFilesystemType: string;
  /** Mount options for the project homes volume. */
  homesMountOptions: string;
  /** Capabilities in the bounding set. */
  capabilityBoundingSet: string[];
};

/** Filesystems that can never carry project quotas, whatever is mounted. */
const QUOTA_INCAPABLE_FILESYSTEMS = new Set(["overlay", "overlayfs", "tmpfs", "aufs"]);

function hasMountOption(options: string, wanted: string): boolean {
  return options.split(",").some((option) => option.trim() === wanted);
}

/**
 * Interprets raw readings into the facts the preflight cares about.
 *
 * The cgroup namespace is inferred from the path in /proc/self/cgroup: a
 * container in a private namespace sees itself at the bare root, while one
 * sharing the host namespace sees its real path under /docker/<id>.
 */
export function parseProbe(readings: RawSystemReadings): SystemProbe {
  const cgroupPath = readings.selfCgroup.trim().split(":").pop() ?? "/";
  const cgroupNamespace = cgroupPath === "/" || cgroupPath === "" ? "private" : "host";

  const filesystem = readings.homesFilesystemType.trim().toLowerCase();
  const projectQuotasEnabled =
    !QUOTA_INCAPABLE_FILESYSTEMS.has(filesystem) &&
    hasMountOption(readings.homesMountOptions, "prjquota");

  return {
    cgroupNamespace,
    cgroupControllers: readings.cgroupControllers.trim().split(/\s+/).filter(Boolean),
    cgroupWritable: hasMountOption(readings.cgroupMountOptions, "rw"),
    homesFilesystem: filesystem,
    projectQuotasEnabled,
    capabilities: readings.capabilityBoundingSet,
  };
}

