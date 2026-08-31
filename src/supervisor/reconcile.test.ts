import { describe, expect, test } from "bun:test";
import { reconcile, type SystemState } from "./reconcile";
import type { StoredProject } from "./store";

const project = (name: string, uid: number): StoredProject => ({
  name,
  type: "static",
  uid,
  internalPort: null,
  command: null,
  netnsIndex: 0,
});

function systemWith(overrides: Partial<SystemState> = {}): SystemState {
  return {
    existingAccounts: new Map(),
    existingSites: new Set(),
    createAccount: async () => {},
    ...overrides,
  };
}

describe("reconciliation", () => {
  test("a project recorded but absent from the system is recreated", async () => {
    const created: { name: string; uid: number }[] = [];
    const report = await reconcile(
      [project("alpha", 10000)],
      systemWith({
        createAccount: async (name, uid) => {
          created.push({ name, uid });
        },
      }),
    );

    expect(created).toEqual([{ name: "alpha", uid: 10000 }]);
    expect(report.recreated).toEqual(["alpha"]);
  });

  test("a project whose account already exists is left alone", async () => {
    const report = await reconcile(
      [project("alpha", 10000)],
      systemWith({ existingAccounts: new Map([["alpha", 10000]]) }),
    );
    expect(report.recreated).toEqual([]);
    expect(report.discrepancies).toEqual([]);
  });

  test("accounts are recreated with the recorded uid, not a fresh one", async () => {
    // Files on the quota volume are owned by uid; a different uid would leave
    // the project unable to read its own deploy.
    let seen = -1;
    await reconcile(
      [project("alpha", 10042)],
      systemWith({
        createAccount: async (_name, uid) => {
          seen = uid;
        },
      }),
    );
    expect(seen).toBe(10042);
  });

  test("an account whose uid disagrees with the record is reported, not silently fixed", async () => {
    // Changing it under a running system could hand one project's files to
    // another, so a human decides.
    const report = await reconcile(
      [project("alpha", 10000)],
      systemWith({ existingAccounts: new Map([["alpha", 19999]]) }),
    );
    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toContain("alpha");
  });

  test("site content with no matching record is reported as orphaned", async () => {
    const report = await reconcile([], systemWith({ existingSites: new Set(["ghost"]) }));
    expect(report.discrepancies.some((d) => d.includes("ghost"))).toBe(true);
  });

  test("a failure on one project does not abort the others", async () => {
    // A single broken project must not leave the whole instance down.
    const created: string[] = [];
    const report = await reconcile(
      [project("alpha", 10000), project("beta", 10001), project("gamma", 10002)],
      systemWith({
        createAccount: async (name) => {
          if (name === "beta") throw new Error("useradd failed");
          created.push(name);
        },
      }),
    );

    expect(created).toEqual(["alpha", "gamma"]);
    expect(report.failed).toEqual(["beta"]);
  });

  test("a failure is reported with its cause", async () => {
    const report = await reconcile(
      [project("alpha", 10000)],
      systemWith({
        createAccount: async () => {
          throw new Error("useradd: uid already in use");
        },
      }),
    );
    expect(report.discrepancies.some((d) => d.includes("uid already in use"))).toBe(true);
  });

  test("reconciling an empty instance reports nothing to do", async () => {
    const report = await reconcile([], systemWith());
    expect(report).toMatchObject({ recreated: [], failed: [], discrepancies: [] });
  });
});
