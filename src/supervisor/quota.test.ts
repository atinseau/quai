import { describe, expect, test } from "bun:test";
import { DEFAULT_DISK_QUOTA, ProjectQuota, parseQuotaReport } from "./quota";

describe("quota commands", () => {
  const quota = new ProjectQuota("/srv/quai/homes", "api", 10000, "/srv/quai/homes/sites/api");

  test("the project id follows its uid, so it survives a restart", () => {
    expect(quota.projectId).toBe(10000);
  });

  test("the directory is marked as a quota project", () => {
    const commands = quota.applyCommands("1Gi").map((c) => c.join(" "));
    expect(commands.some((c) => c.includes("project") && c.includes("-s"))).toBe(true);
  });

  test("a hard limit is set, not merely a warning", () => {
    // A soft limit would only warn while the disk still filled up.
    const commands = quota.applyCommands("1Gi").map((c) => c.join(" "));
    expect(commands.some((c) => c.includes("bhard"))).toBe(true);
  });

  test("the limit is expressed in bytes", () => {
    const commands = quota.applyCommands("1Gi").map((c) => c.join(" "));
    expect(commands.some((c) => c.includes(String(1024 ** 3)))).toBe(true);
  });

  test("commands target the filesystem holding the homes", () => {
    const commands = quota.applyCommands("1Gi").map((c) => c.join(" "));
    expect(commands.every((c) => c.includes("/srv/quai/homes"))).toBe(true);
  });

  test("a malformed size is refused rather than defaulted", () => {
    expect(() => quota.applyCommands("plenty")).toThrow(/size/i);
  });

  test("two projects get distinct quota ids", () => {
    const other = new ProjectQuota("/srv/quai/homes", "beta", 10001, "/srv/quai/homes/sites/beta");
    expect(other.projectId).not.toBe(quota.projectId);
  });

  test("the default quota is modest enough to bound a runaway", () => {
    expect(DEFAULT_DISK_QUOTA).toBe("1Gi");
  });
});

describe("reading usage back", () => {
  test("used and limit are parsed from a report line", () => {
    // Columns: id, used, soft, hard (in KiB by default).
    const report = parseQuotaReport("#10000    512   0   1048576   00 [--------]");
    expect(report).toEqual({ usedBytes: 512 * 1024, limitBytes: 1048576 * 1024 });
  });

  test("a project with no usage yet reads as zero", () => {
    expect(parseQuotaReport("#10000  0  0  1048576  00 [--------]")?.usedBytes).toBe(0);
  });

  test("an unparseable line yields null rather than a wrong number", () => {
    expect(parseQuotaReport("no such project")).toBeNull();
  });

  test("an empty report yields null", () => {
    expect(parseQuotaReport("")).toBeNull();
  });
});


describe("quota ordering", () => {
  test("the directory a quota applies to is exposed, so it can be created first", () => {
    // xfs_quota marks an existing tree. Marking a missing path silently leaves
    // the content on project 0, where no limit applies — seen in the container.
    const quota = new ProjectQuota("/srv/quai/homes", "api", 10000, "/srv/quai/homes/sites/api");
    expect(quota.directory).toBe("/srv/quai/homes/sites/api");
  });

  test("the marked directory is the one the commands target", () => {
    const quota = new ProjectQuota("/srv/quai/homes", "api", 10000, "/srv/quai/homes/sites/api");
    const marking = quota.applyCommands("1Gi")[0]!.join(" ");
    expect(marking).toContain(quota.directory);
  });
});


describe("quota follows the content, whatever its shape", () => {
  test("a static project is capped where its files live", () => {
    const quota = new ProjectQuota("/srv/quai/homes", "site", 10000, "/srv/quai/homes/sites/site");
    expect(quota.directory).toBe("/srv/quai/homes/sites/site");
  });

  test("a service is capped in its own home, not under sites/", () => {
    // Assuming sites/ left every service on quota project 0, uncapped, while
    // the report still showed a limit — observed in the container.
    const quota = new ProjectQuota("/srv/quai/homes", "api", 10001, "/srv/quai/homes/projects/api");
    expect(quota.directory).toBe("/srv/quai/homes/projects/api");
  });

  test("the marking command targets that same path", () => {
    const quota = new ProjectQuota("/srv/quai/homes", "api", 10001, "/srv/quai/homes/projects/api");
    expect(quota.applyCommands("1Gi")[0]!.join(" ")).toContain("/srv/quai/homes/projects/api");
  });

  test("releasing a quota clears the hard limit", () => {
    // Otherwise the limit lingers against a project id that no longer exists.
    const quota = new ProjectQuota("/srv/quai/homes", "api", 10001, "/x");
    expect(quota.releaseCommands()[0]!.join(" ")).toContain("bhard=0");
  });
});

