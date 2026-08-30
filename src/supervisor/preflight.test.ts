import { describe, expect, test } from "bun:test";
import { checkIsolationSupport, type SystemProbe } from "./preflight";

// A system that satisfies every isolation requirement.
const healthy: SystemProbe = {
  cgroupNamespace: "host",
  cgroupControllers: ["cpuset", "cpu", "io", "memory", "pids"],
  cgroupWritable: true,
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
    expect(result.failures).toHaveLength(1);
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
    expect(result.failures[0]!.requirement).toBe("cgroup-controllers");
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
      homesFilesystem: "overlayfs",
      projectQuotasEnabled: false,
      capabilities: [],
    });
    expect(result.failures.length).toBeGreaterThanOrEqual(5);
  });

  test("every failure explains what to change, not just what is wrong", () => {
    const result = checkIsolationSupport({ ...healthy, cgroupNamespace: "private" });
    for (const failure of result.failures) {
      expect(failure.remedy.length).toBeGreaterThan(0);
      expect(failure.observed.length).toBeGreaterThan(0);
    }
  });
});
