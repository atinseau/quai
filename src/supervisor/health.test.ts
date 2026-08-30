import { describe, expect, test } from "bun:test";
import { buildHealthReport } from "./health";

const runtimes = [
  { name: "node", version: "v22.23.2" },
  { name: "python", version: "3.11.2" },
  { name: "bun", version: "1.4.0" },
];

describe("health endpoint", () => {
  test("reports healthy when isolation holds and every runtime answers", () => {
    const report = buildHealthReport({
      isolation: { supported: true, failures: [] },
      runtimes,
    });
    expect(report.status).toBe("healthy");
  });

  test("lists the runtimes it can serve", () => {
    const report = buildHealthReport({
      isolation: { supported: true, failures: [] },
      runtimes,
    });
    expect(report.runtimes.map((r) => r.name).sort()).toEqual(["bun", "node", "python"]);
  });

  test("is unhealthy when an isolation guarantee is missing", () => {
    const report = buildHealthReport({
      isolation: {
        supported: false,
        failures: [
          {
            requirement: "cgroup-namespace",
            guarantee: "caps contain a runaway project",
            observed: 'cgroup namespace is "private"',
            remedy: "Set 'cgroup: host'",
          },
        ],
      },
      runtimes,
    });
    expect(report.status).toBe("unhealthy");
  });

  test("names the failing requirements so an operator can act without shelling in", () => {
    const report = buildHealthReport({
      isolation: {
        supported: false,
        failures: [
          {
            requirement: "disk-quotas",
            guarantee: "one project cannot fill the shared disk",
            observed: "homes are on overlayfs",
            remedy: "Mount an XFS volume with prjquota",
          },
        ],
      },
      runtimes,
    });
    expect(report.isolation.failing).toEqual(["disk-quotas"]);
  });

  test("a runtime that fails to answer makes the report degraded, not unhealthy", () => {
    // Isolation is the safety property; a missing runtime only narrows what
    // Quai can host, so it must not read the same as a broken guarantee.
    const report = buildHealthReport({
      isolation: { supported: true, failures: [] },
      runtimes: [
        { name: "node", version: "v22.23.2" },
        { name: "python", version: null },
        { name: "bun", version: "1.4.0" },
      ],
    });
    expect(report.status).toBe("degraded");
  });
});

