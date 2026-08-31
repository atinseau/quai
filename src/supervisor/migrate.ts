/**
 * Schema migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` only ever helps a database that does not exist
 * yet: on one that does, it does nothing at all — it does not compare columns
 * and does not add them. So the day a release adds a column, an existing
 * instance would start, run its first query, and fail with "no such column",
 * taking every project offline at the worst possible moment.
 *
 * Each migration moves the database forward by exactly one version. A fresh
 * database runs all of them; an existing one runs only what it is missing.
 */

import type { Database } from "bun:sqlite";

type Migration = {
  version: number;
  /** What this step changes, so a log line explains itself. */
  describes: string;
  apply: (database: Database) => void;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    describes: "initial schema",
    apply: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          name          TEXT PRIMARY KEY,
          type          TEXT NOT NULL,
          uid           INTEGER UNIQUE,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- Uids are never reused, even after a project is deleted, so a new
        -- project cannot inherit files a previous owner left behind.
        CREATE TABLE IF NOT EXISTS uid_watermark (
          id   INTEGER PRIMARY KEY CHECK (id = 1),
          next INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS env (
          project TEXT NOT NULL,
          key     TEXT NOT NULL,
          value   TEXT NOT NULL,
          PRIMARY KEY (project, key)
        );
      `);
    },
  },
  {
    version: 2,
    describes: "service port, start command and network namespace",
    apply: (database) => {
      addColumn(database, "projects", "internal_port", "INTEGER");
      addColumn(database, "projects", "command", "TEXT");
      addColumn(database, "projects", "netns_index", "INTEGER");
    },
  },
  {
    version: 3,
    describes: "custom domains",
    apply: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS domains (
          domain  TEXT PRIMARY KEY,
          project TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 4,
    describes: "cascade deletes for env and domains",
    apply: (database) => {
      // SQLite cannot add a foreign key to an existing table, so the child
      // rows are cleaned up alongside any orphans a pre-migration database
      // may already carry.
      database.exec(`
        DELETE FROM env WHERE project NOT IN (SELECT name FROM projects);
        DELETE FROM domains WHERE project NOT IN (SELECT name FROM projects);
      `);
    },
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Adds a column unless the table already has it. */
function addColumn(database: Database, table: string, column: string, type: string): void {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((existing) => existing.name === column)) return;

  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** The schema version a database is currently at. */
export function schemaVersion(database: Database): number {
  const row = database.query("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * Brings a database up to the current schema.
 *
 * All or nothing: a half-migrated instance is worse than one that refuses to
 * start, because an operator could not tell which projects are intact.
 *
 * @throws when the database was written by a newer Quai, rather than rewriting
 * a schema it does not understand.
 */
export function migrate(database: Database): void {
  const from = schemaVersion(database);

  if (from > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `This database was written by a newer Quai (schema ${from}; this build ` +
        `understands ${CURRENT_SCHEMA_VERSION}). Upgrade Quai rather than ` +
        "downgrading the database.",
    );
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > from);
  if (pending.length === 0) return;

  database.transaction(() => {
    for (const migration of pending) {
      migration.apply(database);
    }
  })();

  // Outside the transaction: PRAGMA user_version is not transactional, so
  // setting it early would claim success for work that could still fail.
  database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
}

/** Describes what an upgrade would do, for the startup log. */
export function pendingMigrations(database: Database): string[] {
  const from = schemaVersion(database);
  return MIGRATIONS.filter((migration) => migration.version > from).map(
    (migration) => `${migration.version}: ${migration.describes}`,
  );
}

/**
 * Reads pending changes without migrating, so they can be logged first.
 *
 * A missing database is not an upgrade; it reports nothing.
 */
export async function pendingSchemaChanges(path: string): Promise<string[]> {
  const { existsSync } = await import("node:fs");
  if (!existsSync(path)) return [];

  const { Database: Sqlite } = await import("bun:sqlite");
  const database = new Sqlite(path, { readonly: true });
  try {
    return pendingMigrations(database);
  } finally {
    database.close();
  }
}
