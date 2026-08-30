/**
 * Isolation preflight.
 *
 * Quai refuses to run on a host that cannot enforce its isolation promises.
 * Starting anyway would be worse than failing: the prototype showed that a
 * memory cap can be written without any error and still contain nothing when
 * the container runs in a private cgroup namespace. A project would believe it
 * is capped while its neighbours stay exposed.
 *
 * Static indicators alone cannot establish this. Every signal can look correct
 * while delegation still fails, so the supervisor proves the guarantee by
 * actually performing the delegation and reports the result here.
 */

/** Outcome of really attempting cgroup delegation, not merely inspecting it. */
export type DelegationOutcome = {
  /** Whether the supervisor tried. An untried delegation proves nothing. */
  attempted: boolean;
  succeeded: boolean;
  /** The underlying system message, surfaced so an operator can act on it. */
  detail: string;
};

export type SystemProbe = {
  /** Cgroup namespace mode. Only "host" lets the container see its real path. */
  cgroupNamespace: "host" | "private";
  /** Controllers available in the unified hierarchy. */
  cgroupControllers: string[];
  /** Whether /sys/fs/cgroup is mounted read-write. */
  cgroupWritable: boolean;
  /** Result of really delegating controllers to a child cgroup. */
  cgroupDelegation: DelegationOutcome;
  /** Filesystem backing the project homes. */
  homesFilesystem: string;
  /** Whether that filesystem carries project quotas. */
  projectQuotasEnabled: boolean;
  /** Capabilities the container can actually exercise. */
  capabilities: string[];
};

export type Requirement =
  | "cgroup-namespace"
  | "cgroup-writable"
  | "cgroup-controllers"
  | "cgroup-delegation"
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
 * XFS is the only filesystem Quai provisions and tests project quotas against.
 * ext4 project quotas exist, but accepting them would promise a guarantee
 * nobody has verified on this platform.
 */
const REQUIRED_HOMES_FILESYSTEM = "xfs";

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

  if (!probe.cgroupDelegation.attempted || !probe.cgroupDelegation.succeeded) {
    failures.push({
      requirement: "cgroup-delegation",
      guarantee: "Limits written for a project genuinely contain its processes",
      observed: probe.cgroupDelegation.attempted
        ? `delegation attempt failed: ${probe.cgroupDelegation.detail}`
        : `delegation was never attempted: ${probe.cgroupDelegation.detail}`,
      remedy:
        "The supervisor must be able to move itself into a leaf cgroup and then " +
        "write 'cgroup.subtree_control'. A cgroup cannot both hold processes and " +
        "delegate controllers to its children (the 'no internal process' rule), " +
        "so check the container is not pinned to a populated cgroup.",
    });
  }

  const filesystem = probe.homesFilesystem.toLowerCase();
  if (filesystem !== REQUIRED_HOMES_FILESYSTEM || !probe.projectQuotasEnabled) {
    failures.push({
      requirement: "disk-quotas",
      guarantee: "One project cannot fill the disk shared by all the others",
      observed:
        filesystem === REQUIRED_HOMES_FILESYSTEM
          ? "homes are on xfs but without project quotas enabled"
          : `homes are on '${probe.homesFilesystem || "an unknown filesystem"}', not xfs`,
      remedy:
        "Mount an XFS volume with the 'prjquota' option for the project homes. " +
        "overlayfs cannot carry quotas at all, and other filesystems are not " +
        "verified against Quai's quota handling.",
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

