/**
 * Persistent state.
 *
 * SQLite in the state volume is the source of truth. It has to be: UNIX
 * accounts, cgroups and network namespaces do not survive the container being
 * recreated, so the supervisor rebuilds them from here on every boot. A flat
 * file would do until two deploys overlap, which is exactly when losing a
 * write matters most.
 */

import { Database } from "bun:sqlite";
import type { ProjectRecord } from "./router";

/** Project uids start well above the system range to avoid collisions. */
const FIRST_UID = 10000;

export type StoredProject = ProjectRecord & {
  uid: number;
  internalPort: number | null;
};

export class Store {
  constructor(readonly database: Database) {
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        name          TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        uid           INTEGER UNIQUE,
        internal_port INTEGER,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );

      -- Uids are never reused, even after a project is deleted, so a new
      -- project cannot inherit files a previous owner left behind.
      CREATE TABLE IF NOT EXISTS uid_watermark (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        next INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS env (
        project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (project, key)
      );
    `);
    this.database.run("INSERT OR IGNORE INTO uid_watermark (id, next) VALUES (1, ?)", [
      FIRST_UID,
    ]);
  }

  /** Runs a unit of work atomically; nothing is committed if it throws. */
  transaction<T>(work: () => T): T {
    return this.database.transaction(work)();
  }

  lookup(name: string): StoredProject | null {
    const row = this.database
      .query("SELECT name, type, uid, internal_port FROM projects WHERE name = ?")
      .get(name) as
      | { name: string; type: string; uid: number | null; internal_port: number | null }
      | null;

    if (row === null) return null;
    return {
      name: row.name,
      type: row.type as ProjectRecord["type"],
      uid: row.uid ?? 0,
      internalPort: row.internal_port,
    };
  }

  list(): StoredProject[] {
    const rows = this.database
      .query("SELECT name, type, uid, internal_port FROM projects ORDER BY name")
      .all() as {
      name: string;
      type: string;
      uid: number | null;
      internal_port: number | null;
    }[];

    return rows.map((row) => ({
      name: row.name,
      type: row.type as ProjectRecord["type"],
      uid: row.uid ?? 0,
      internalPort: row.internal_port,
    }));
  }

  upsertProject(record: ProjectRecord & { internalPort?: number | null }): void {
    this.database.run(
      `INSERT INTO projects (name, type, internal_port) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET type = excluded.type,
                                       internal_port = excluded.internal_port`,
      [record.name, record.type, record.internalPort ?? null],
    );
  }

  removeProject(name: string): void {
    this.database.run("DELETE FROM projects WHERE name = ?", [name]);
  }

  /**
   * Returns the project's uid, assigning one on first call.
   *
   * The watermark only ever moves forward, so a deleted project's uid is
   * retired rather than recycled.
   */
  allocateUid(name: string): number {
    return this.transaction(() => {
      const existing = this.database
        .query("SELECT uid FROM projects WHERE name = ? AND uid IS NOT NULL")
        .get(name) as { uid: number } | null;
      if (existing !== null) return existing.uid;

      const { next } = this.database
        .query("SELECT next FROM uid_watermark WHERE id = 1")
        .get() as { next: number };

      this.database.run("UPDATE uid_watermark SET next = ? WHERE id = 1", [next + 1]);
      this.database.run(
        `INSERT INTO projects (name, type, uid) VALUES (?, 'static', ?)
         ON CONFLICT(name) DO UPDATE SET uid = excluded.uid`,
        [name, next],
      );
      return next;
    });
  }

  getEnv(project: string): Record<string, string> {
    const rows = this.database
      .query("SELECT key, value FROM env WHERE project = ?")
      .all(project) as { key: string; value: string }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  setEnv(project: string, key: string, value: string): void {
    this.database.run(
      `INSERT INTO env (project, key, value) VALUES (?, ?, ?)
       ON CONFLICT(project, key) DO UPDATE SET value = excluded.value`,
      [project, key, value],
    );
  }

  unsetEnv(project: string, key: string): void {
    this.database.run("DELETE FROM env WHERE project = ? AND key = ?", [project, key]);
  }
}

export function openStore(path: string): Store {
  return new Store(new Database(path, { create: true }));
}

