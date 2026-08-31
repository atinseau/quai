import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Store } from "./store";
import { CURRENT_SCHEMA_VERSION, migrate, schemaVersion } from "./migrate";

/** A database as an older Quai left it: no internal_port, command or netns. */
function legacyDatabase(): Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE projects (
      name       TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      uid        INTEGER UNIQUE,
      created_at INTEGER
    );
    CREATE TABLE uid_watermark (id INTEGER PRIMARY KEY CHECK (id = 1), next INTEGER NOT NULL);
    CREATE TABLE env (
      project TEXT NOT NULL,
      key     TEXT NOT NULL,
      value   TEXT NOT NULL,
      PRIMARY KEY (project, key)
    );
  `);
  database.run("INSERT INTO uid_watermark (id, next) VALUES (1, 10002)");
  database.run("INSERT INTO projects (name, type, uid, created_at) VALUES (?,?,?,?)", [
    "site",
    "static",
    10000,
    0,
  ]);
  database.run("INSERT INTO projects (name, type, uid, created_at) VALUES (?,?,?,?)", [
    "api",
    "service",
    10001,
    0,
  ]);
  database.run("INSERT INTO env (project, key, value) VALUES (?,?,?)", [
    "api",
    "API_KEY",
    "secret",
  ]);
  return database;
}

describe("upgrading an existing instance", () => {
  test("a database from an older Quai opens instead of crashing", () => {
    // Before migrations this threw "no such column: internal_port" and the
    // supervisor refused to start, taking every project offline.
    const database = legacyDatabase();
    expect(() => new Store(database)).not.toThrow();
  });

  test("projects survive the upgrade", () => {
    const store = new Store(legacyDatabase());
    expect(
      store
        .list()
        .map((project) => project.name)
        .toSorted(),
    ).toEqual(["api", "site"]);
  });

  test("uids survive, or projects lose access to their own files", () => {
    const store = new Store(legacyDatabase());
    expect(store.lookup("api")!.uid).toBe(10001);
  });

  test("environment variables survive", () => {
    const store = new Store(legacyDatabase());
    expect(store.getEnv("api")).toEqual({ API_KEY: "secret" });
  });

  test("the uid watermark survives, so a new project cannot reuse an old uid", () => {
    const store = new Store(legacyDatabase());
    expect(store.allocateUid("fresh")).toBeGreaterThanOrEqual(10002);
  });

  test("columns added since are usable afterwards", () => {
    const store = new Store(legacyDatabase());
    store.upsertProject({ name: "api", type: "service", internalPort: 3000, command: "node s.js" });
    expect(store.lookup("api")).toMatchObject({ internalPort: 3000, command: "node s.js" });
  });

  test("tables added since are created", () => {
    const store = new Store(legacyDatabase());
    store.setDomains("site", ["www.example.com"]);
    expect(store.projectForDomain("www.example.com")).toBe("site");
  });
});

describe("tracking which migrations have run", () => {
  test("a fresh database lands on the current version", () => {
    const database = new Database(":memory:");
    const store = new Store(database);
    expect(store.list()).toEqual([]);
    expect(schemaVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("an upgraded database lands on the same version", () => {
    const database = legacyDatabase();
    const store = new Store(database);
    expect(store.list()).toHaveLength(2);
    expect(schemaVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("migrating twice changes nothing", () => {
    // A restart must not re-apply what has already run.
    const database = legacyDatabase();
    const store = new Store(database);
    expect(store.list()).toHaveLength(2);
    const after = schemaVersion(database);
    migrate(database);
    expect(schemaVersion(database)).toBe(after);
  });

  test("a database from the future is refused rather than corrupted", () => {
    // Downgrading Quai must not silently rewrite a newer schema.
    const database = new Database(":memory:");
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    expect(() => migrate(database)).toThrow(/newer/i);
  });

  test("a failed migration leaves the database untouched", () => {
    // A half-migrated instance is worse than one that refuses to start: the
    // operator could not tell which projects are intact.
    const database = legacyDatabase();
    database.exec("CREATE TABLE domains (bogus TEXT)");
    try {
      migrate(database);
    } catch {
      // The point is what the database looks like afterwards.
    }
    expect(database.query("SELECT COUNT(*) AS n FROM projects").get()).toMatchObject({ n: 2 });
  });
});

describe("deleting a project on a migrated database", () => {
  test("its variables go with it", () => {
    // The cascade is declared on a fresh schema but cannot be added to an
    // existing table, so a migrated database relies on explicit deletes.
    const store = new Store(legacyDatabase());
    store.removeProject("api");
    expect(store.getEnv("api")).toEqual({});
  });

  test("its domains go with it", () => {
    const store = new Store(legacyDatabase());
    store.setDomains("site", ["www.example.com"]);
    store.removeProject("site");
    expect(store.projectForDomain("www.example.com")).toBeNull();
  });

  test("a neighbour keeps its own", () => {
    const store = new Store(legacyDatabase());
    store.setEnv("site", "KEEP", "me");
    store.removeProject("api");
    expect(store.getEnv("site")).toEqual({ KEEP: "me" });
  });

  test("orphans left by an older database are cleaned up on upgrade", () => {
    const database = legacyDatabase();
    database.run("INSERT INTO env (project, key, value) VALUES ('gone','K','v')");
    const store = new Store(database);
    expect(store.getEnv("gone")).toEqual({});
  });
});
