import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Store } from "./store";

let store: Store;

beforeEach(() => {
  store = new Store(new Database(":memory:"));
});

describe("project records", () => {
  test("an upserted project can be looked up", () => {
    store.upsertProject({ name: "my-site", type: "static" });
    expect(store.lookup("my-site")).toMatchObject({ name: "my-site", type: "static" });
  });

  test("an unknown project looks up as null", () => {
    expect(store.lookup("nope")).toBeNull();
  });

  test("re-upserting updates in place rather than duplicating", () => {
    store.upsertProject({ name: "my-site", type: "static" });
    store.upsertProject({ name: "my-site", type: "service" });
    expect(store.list()).toHaveLength(1);
    expect(store.lookup("my-site")!.type).toBe("service");
  });

  test("removing a project makes it unknown again", () => {
    store.upsertProject({ name: "my-site", type: "static" });
    store.removeProject("my-site");
    expect(store.lookup("my-site")).toBeNull();
  });
});

describe("uid allocation", () => {
  test("a project keeps the same uid across lookups", () => {
    const first = store.allocateUid("alpha");
    expect(store.allocateUid("alpha")).toBe(first);
  });

  test("two projects never share a uid", () => {
    expect(store.allocateUid("alpha")).not.toBe(store.allocateUid("beta"));
  });

  test("uids start above the system range", () => {
    // Below 10000 risks colliding with distribution accounts.
    expect(store.allocateUid("alpha")).toBeGreaterThanOrEqual(10000);
  });

  test("a released uid is not handed to another project", () => {
    // Reusing a uid would let a new project inherit files left behind by the
    // old one if any survived deletion.
    const released = store.allocateUid("alpha");
    store.removeProject("alpha");
    expect(store.allocateUid("beta")).not.toBe(released);
  });

  test("uids survive a reopen, so accounts can be recreated identically", () => {
    const uid = store.allocateUid("alpha");
    const reopened = new Store(store.database);
    expect(reopened.lookup("alpha")?.uid).toBe(uid);
  });
});

describe("concurrent deploys", () => {
  test("interleaved upserts leave exactly one record per project", () => {
    for (let i = 0; i < 50; i++) {
      store.upsertProject({ name: "alpha", type: "static" });
      store.upsertProject({ name: "beta", type: "static" });
    }
    expect(store.list()).toHaveLength(2);
  });

  test("a failed transaction leaves no partial record", () => {
    expect(() =>
      store.transaction(() => {
        store.upsertProject({ name: "alpha", type: "static" });
        throw new Error("deploy failed halfway");
      }),
    ).toThrow();
    expect(store.lookup("alpha")).toBeNull();
  });

  test("a successful transaction commits everything at once", () => {
    store.transaction(() => {
      store.upsertProject({ name: "alpha", type: "static" });
      store.upsertProject({ name: "beta", type: "static" });
    });
    expect(store.list()).toHaveLength(2);
  });
});

describe("environment variables", () => {
  test("a variable set for a project is read back", () => {
    store.upsertProject({ name: "alpha", type: "static" });
    store.setEnv("alpha", "NODE_ENV", "production");
    expect(store.getEnv("alpha")).toEqual({ NODE_ENV: "production" });
  });

  test("setting the same key twice replaces the value", () => {
    store.upsertProject({ name: "alpha", type: "static" });
    store.setEnv("alpha", "K", "one");
    store.setEnv("alpha", "K", "two");
    expect(store.getEnv("alpha")).toEqual({ K: "two" });
  });

  test("one project cannot read another's variables", () => {
    store.upsertProject({ name: "alpha", type: "static" });
    store.upsertProject({ name: "beta", type: "static" });
    store.setEnv("alpha", "SECRET", "x");
    expect(store.getEnv("beta")).toEqual({});
  });

  test("removing a project discards its variables", () => {
    store.upsertProject({ name: "alpha", type: "static" });
    store.setEnv("alpha", "SECRET", "x");
    store.removeProject("alpha");
    expect(store.getEnv("alpha")).toEqual({});
  });

  test("unsetting a variable removes it", () => {
    store.upsertProject({ name: "alpha", type: "static" });
    store.setEnv("alpha", "K", "v");
    store.unsetEnv("alpha", "K");
    expect(store.getEnv("alpha")).toEqual({});
  });
});
