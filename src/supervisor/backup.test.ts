import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Store } from "./store";
import { captureBackup, describeBackup, restoreBackup } from "./backup";

let store: Store;

beforeEach(() => {
  store = new Store(new Database(":memory:"));
});

describe("capturing an instance", () => {
  test("a backup carries every project", async () => {
    store.upsertProject({ name: "alpha", type: "static" });
    store.upsertProject({ name: "beta", type: "service" });

    const backup = await captureBackup(store);
    expect(backup.projects.map((p) => p.name).toSorted()).toEqual(["alpha", "beta"]);
  });

  test("uids are captured, since files on the volume are owned by them", async () => {
    const uid = store.allocateUid("alpha");
    const backup = await captureBackup(store);
    expect(backup.projects[0]!.uid).toBe(uid);
  });

  test("environment variables are captured", async () => {
    store.upsertProject({ name: "alpha", type: "service" });
    store.setEnv("alpha", "API_KEY", "secret");

    const backup = await captureBackup(store);
    expect(backup.env.alpha).toEqual({ API_KEY: "secret" });
  });

  test("custom domains are captured", async () => {
    store.upsertProject({ name: "alpha", type: "static" });
    store.setDomains("alpha", ["www.example.com"]);

    const backup = await captureBackup(store);
    expect(backup.domains.alpha).toEqual(["www.example.com"]);
  });

  test("a backup records when it was taken", async () => {
    const backup = await captureBackup(store);
    expect(backup.takenAt).toBeGreaterThan(0);
  });

  test("a backup records its format version, so a future one can be read", async () => {
    const backup = await captureBackup(store);
    expect(backup.version).toBe(1);
  });

  test("an empty instance produces a valid, empty backup", async () => {
    const backup = await captureBackup(store);
    expect(backup.projects).toEqual([]);
  });
});

describe("describing a backup before relying on it", () => {
  test("it says how many projects it holds", async () => {
    store.upsertProject({ name: "alpha", type: "static" });
    const summary = describeBackup(await captureBackup(store));
    expect(summary).toContain("1 project");
  });

  test("it names them, so an operator can check before restoring", async () => {
    store.upsertProject({ name: "alpha", type: "static" });
    expect(describeBackup(await captureBackup(store))).toContain("alpha");
  });

  test("a backup from an unknown version is refused rather than half-read", () => {
    expect(() =>
      describeBackup({ version: 99, takenAt: 0, projects: [], env: {}, domains: {} } as never),
    ).toThrow(/version/i);
  });
});

describe("restoring an instance", () => {
  test("projects come back", async () => {
    store.upsertProject({ name: "alpha", type: "static" });
    const backup = await captureBackup(store);

    const fresh = new Store(new Database(":memory:"));
    await restoreBackup(fresh, backup);
    expect(fresh.lookup("alpha")).toMatchObject({ name: "alpha", type: "static" });
  });

  test("uids come back unchanged, or projects lose their own files", async () => {
    const uid = store.allocateUid("alpha");
    const backup = await captureBackup(store);

    const fresh = new Store(new Database(":memory:"));
    await restoreBackup(fresh, backup);
    expect(fresh.lookup("alpha")!.uid).toBe(uid);
  });

  test("environment variables come back", async () => {
    store.upsertProject({ name: "alpha", type: "service" });
    store.setEnv("alpha", "API_KEY", "secret");
    const backup = await captureBackup(store);

    const fresh = new Store(new Database(":memory:"));
    await restoreBackup(fresh, backup);
    expect(fresh.getEnv("alpha")).toEqual({ API_KEY: "secret" });
  });

  test("custom domains come back", async () => {
    store.upsertProject({ name: "alpha", type: "static" });
    store.setDomains("alpha", ["www.example.com"]);
    const backup = await captureBackup(store);

    const fresh = new Store(new Database(":memory:"));
    await restoreBackup(fresh, backup);
    expect(fresh.projectForDomain("www.example.com")).toBe("alpha");
  });

  test("restoring twice is not an error", async () => {
    store.upsertProject({ name: "alpha", type: "static" });
    const backup = await captureBackup(store);

    const fresh = new Store(new Database(":memory:"));
    await restoreBackup(fresh, backup);
    await restoreBackup(fresh, backup);
    expect(fresh.list()).toHaveLength(1);
  });

  test("a restore is all or nothing", async () => {
    // A half-restored instance would be worse than a failed restore: some
    // projects would exist without their variables.
    const backup = {
      version: 1,
      takenAt: 1,
      projects: [
        {
          name: "alpha",
          type: "static",
          uid: 10000,
          internalPort: null,
          command: null,
          netnsIndex: 0,
        },
      ],
      env: { alpha: { KEY: 42 as never } },
      domains: {},
    };

    const fresh = new Store(new Database(":memory:"));
    await restoreBackup(fresh, backup as never).catch(() => {});
    expect(fresh.list()).toEqual([]);
  });
});
