import { describe, expect, test } from "bun:test";
import { checkIsolationSupport, type SystemProbe } from "./preflight";

const healthy: SystemProbe = {
  cgroupNamespace: "host",
  cgroupControllers: ["cpuset", "cpu", "io", "memory", "pids"],
  cgroupWritable: true,
  cgroupDelegation: { attempted: true, succeeded: true, detail: "delegated cpu, memory, pids" },
  homesFilesystem: "xfs",
  projectQuotasEnabled: true,
  capabilities: ["NET_ADMIN", "SYS_ADMIN"],
};

describe("isolation preflight", () => {
  test("a fully provisioned host is supported", () => {
    const result = checkIsolationSupport(healthy);
    expect(result.supported).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("a private cgroup namespace is rejected, because memory caps silently do nothing", () => {
    const result = checkIsolationSupport({ ...healthy, cgroupNamespace: "private" });
    expect(result.supported).toBe(false);
    expect(result.failures.map((f) => f.requirement)).toContain("cgroup-namespace");
    expect(result.failures[0]!.remedy).toContain("cgroup: host");
  });

  test("a read-only cgroup filesystem is rejected", () => {
    const result = checkIsolationSupport({ ...healthy, cgroupWritable: false });
    expect(result.supported).toBe(false);
    expect(result.failures[0]!.remedy).toContain("/sys/fs/cgroup");
  });

  test("a missing memory controller is rejected", () => {
    const result = checkIsolationSupport({
      ...healthy,
      cgroupControllers: ["cpuset", "io", "pids"],
    });
    expect(result.supported).toBe(false);
    expect(result.failures.map((f) => f.requirement)).toContain("cgroup-controllers");
  });

  test("static indicators are not enough: a failed delegation is rejected", () => {
    // The point of the whole preflight. Every static signal can look right
    // while the delegation still fails, which is the "no internal process"
    // rule the prototype hit. Only an attempted delegation proves the caps
    // will actually contain anything.
    const result = checkIsolationSupport({
      ...healthy,
      cgroupDelegation: {
        attempted: true,
        succeeded: false,
        detail: "cannot write cgroup.subtree_control: device or resource busy",
      },
    });
    expect(result.supported).toBe(false);
    expect(result.failures.map((f) => f.requirement)).toContain("cgroup-delegation");
  });

  test("a delegation failure surfaces the underlying system error", () => {
    const result = checkIsolationSupport({
      ...healthy,
      cgroupDelegation: { attempted: true, succeeded: false, detail: "permission denied" },
    });
    const failure = result.failures.find((f) => f.requirement === "cgroup-delegation")!;
    expect(failure.observed).toContain("permission denied");
  });

  test("a delegation that was never attempted cannot count as proof", () => {
    const result = checkIsolationSupport({
      ...healthy,
      cgroupDelegation: { attempted: false, succeeded: false, detail: "not attempted" },
    });
    expect(result.supported).toBe(false);
  });

  test("overlayfs homes are rejected, because they cannot carry disk quotas", () => {
    const result = checkIsolationSupport({
      ...healthy,
      homesFilesystem: "overlayfs",
      projectQuotasEnabled: false,
    });
    expect(result.supported).toBe(false);
    expect(result.failures.map((f) => f.requirement)).toContain("disk-quotas");
  });

  test("an xfs volume mounted without prjquota is rejected", () => {
    const result = checkIsolationSupport({ ...healthy, projectQuotasEnabled: false });
    expect(result.supported).toBe(false);
    expect(result.failures[0]!.remedy).toContain("prjquota");
  });

  test("a non-xfs filesystem is rejected even when it claims project quotas", () => {
    // The ticket requires XFS specifically. ext4 project quotas exist but are
    // not what Quai provisions or tests against, so accepting them would be
    // promising a guarantee nobody has verified.
    const result = checkIsolationSupport({
      ...healthy,
      homesFilesystem: "ext4",
      projectQuotasEnabled: true,
    });
    expect(result.supported).toBe(false);
    expect(result.failures.map((f) => f.requirement)).toContain("disk-quotas");
  });

  test("missing NET_ADMIN is rejected, because network namespaces need it", () => {
    const result = checkIsolationSupport({ ...healthy, capabilities: ["SYS_ADMIN"] });
    expect(result.supported).toBe(false);
    expect(result.failures[0]!.requirement).toBe("capabilities");
  });

  test("every failing requirement is reported at once, not just the first", () => {
    const result = checkIsolationSupport({
      cgroupNamespace: "private",
      cgroupControllers: [],
      cgroupWritable: false,
      cgroupDelegation: { attempted: true, succeeded: false, detail: "read-only" },
      homesFilesystem: "overlayfs",
      projectQuotasEnabled: false,
      capabilities: [],
    });
    expect(result.failures.map((f) => f.requirement).sort()).toEqual([
      "capabilities",
      "cgroup-controllers",
      "cgroup-delegation",
      "cgroup-namespace",
      "cgroup-writable",
      "disk-quotas",
    ]);
  });

  test("every failure explains what to change, not just what is wrong", () => {
    const result = checkIsolationSupport({ ...healthy, cgroupNamespace: "private" });
    for (const failure of result.failures) {
      expect(failure.remedy.length).toBeGreaterThan(0);
      expect(failure.observed.length).toBeGreaterThan(0);
    }
  });
});

