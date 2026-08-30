/**
 * Isolation preflight.
 *
 * Quai refuses to run on a host that cannot enforce its isolation promises.
 * Starting anyway would be worse than failing: the prototype showed that a
 * memory cap can be written without any error and still contain nothing when
 * the container runs in a private cgroup namespace. A project would believe it
 * is capped while its neighbours stay exposed.
 */

export type SystemProbe = {
  /** Cgroup namespace mode. Only "host" lets the container see its real path. */
  cgroupNamespace: "host" | "private";
  /** Controllers available in the unified hierarchy. */
  cgroupControllers: string[];
  /** Whether /sys/fs/cgroup is mounted read-write. */
  cgroupWritable: boolean;
  /** Filesystem backing the project homes. */
  homesFilesystem: string;
  /** Whether that filesystem carries project quotas. */
  projectQuotasEnabled: boolean;
  /** Effective capabilities of the container. */
  capabilities: string[];
};

export type Requirement =
  | "cgroup-namespace"
  | "cgroup-writable"
  | "cgroup-controllers"
  | "disk-quotas"
  | "capabilities";

export type Failure = {
  requirement: Requirement;
  /** What the isolation guarantee would be if this were satisfied. */
  guarantee: string;
  /** What was actually found on this host. */
  observed: string;
  /** What the operator must change to fix it. */
  remedy: string;
};

export type PreflightResult = {
  supported: boolean;
  failures: Failure[];
};

const REQUIRED_CONTROLLERS = ["memory", "cpu", "pids"] as const;
const REQUIRED_CAPABILITIES = ["NET_ADMIN", "SYS_ADMIN"] as const;

/**
 * Checks every isolation requirement and reports all failures at once.
 *
 * Reporting them together matters: an operator provisioning a host should see
 * the whole list in one pass rather than rediscovering one more missing option
 * on every restart.
 */
export function checkIsolationSupport(probe: SystemProbe): PreflightResult {
  const failures: Failure[] = [];

  if (probe.cgroupNamespace !== "host") {
    failures.push({
      requirement: "cgroup-namespace",
      guarantee: "Resource caps actually contain a runaway project",
      observed: `cgroup namespace is "${probe.cgroupNamespace}"`,
      remedy:
        "Set 'cgroup: host' on the service. In a private namespace the container " +
        "sees itself at the root '0::/' and cannot move a process into a capped " +
        "cgroup, so memory.max is written successfully and enforces nothing.",
    });
  }

  if (!probe.cgroupWritable) {
    failures.push({
      requirement: "cgroup-writable",
      guarantee: "Per-project cgroups can be created at all",
      observed: "/sys/fs/cgroup is mounted read-only",
      remedy:
        "Mount /sys/fs/cgroup read-write on the service. Note that 'privileged: true' " +
        "does not substitute for this: the prototype found it fails where the " +
        "explicit mount succeeds.",
    });
  }

  const missingControllers = REQUIRED_CONTROLLERS.filter(
    (c) => !probe.cgroupControllers.includes(c),
  );
  if (missingControllers.length > 0) {
    failures.push({
      requirement: "cgroup-controllers",
      guarantee: "Memory, CPU and PID limits can be enforced per project",
      observed: `missing controllers: ${missingControllers.join(", ")}`,
      remedy:
        "Enable cgroup v2 with the memory, cpu and pids controllers on the host " +
        "kernel, then delegate them to the container subtree.",
    });
  }

  if (!probe.projectQuotasEnabled) {
    failures.push({
      requirement: "disk-quotas",
      guarantee: "One project cannot fill the disk shared by all the others",
      observed: `homes are on ${probe.homesFilesystem} without project quotas`,
      remedy:
        "Mount an XFS volume with the 'prjquota' option for the project homes. " +
        "overlayfs cannot carry quotas, so a bind mount onto the container " +
        "filesystem will not do.",
    });
  }

  const missingCapabilities = REQUIRED_CAPABILITIES.filter(
    (c) => !probe.capabilities.includes(c),
  );
  if (missingCapabilities.length > 0) {
    failures.push({
      requirement: "capabilities",
      guarantee: "Projects get separate network namespaces and confined processes",
      observed: `missing capabilities: ${missingCapabilities.join(", ")}`,
      remedy: "Add 'cap_add: [NET_ADMIN, SYS_ADMIN]' to the service.",
    });
  }

  return { supported: failures.length === 0, failures };
}

/** Renders a preflight failure as an operator-facing startup error. */
export function formatFailures(failures: Failure[]): string {
  const lines = [
    "Quai refuses to start: this host cannot enforce project isolation.",
    "",
  ];
  for (const failure of failures) {
    lines.push(`  [${failure.requirement}] ${failure.guarantee}`);
    lines.push(`      found:  ${failure.observed}`);
    lines.push(`      fix:    ${failure.remedy}`);
    lines.push("");
  }
  return lines.join("\n");
}

