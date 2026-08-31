/**
 * Backing up and restoring an instance.
 *
 * The state database holds every project's uid, port, command, variables and
 * domains. Losing the volume loses all of it, and the uids in particular
 * cannot be reinvented: files on the quota volume are owned by them, so a
 * project restored under a fresh uid could not read its own deploy.
 */

import type { Store, StoredProject } from "./store";

/** Bumped when the shape changes, so an older reader refuses rather than guesses. */
const FORMAT_VERSION = 1;

export type Backup = {
  version: number;
  takenAt: number;
  projects: StoredProject[];
  env: Record<string, Record<string, string>>;
  domains: Record<string, string[]>;
};

/**
 * Captures the instance.
 *
 * Read inside a transaction so a deploy running at the same time cannot leave
 * the backup describing a project that half exists.
 */
export async function captureBackup(store: Store): Promise<Backup> {
  return store.transaction(() => {
    const projects = store.list();

    const env: Record<string, Record<string, string>> = {};
    const domains: Record<string, string[]> = {};

    for (const project of projects) {
      env[project.name] = store.getEnv(project.name);
      domains[project.name] = store.domainsFor(project.name);
    }

    return { version: FORMAT_VERSION, takenAt: Date.now(), projects, env, domains };
  });
}

/** A one-line summary, so an operator can check a backup before needing it. */
export function describeBackup(backup: Backup): string {
  if (backup.version !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup version ${backup.version}; this Quai reads version ${FORMAT_VERSION}.`,
    );
  }

  const when = new Date(backup.takenAt).toISOString();
  const count = backup.projects.length;
  const names = backup.projects.map((project) => project.name).join(", ");

  return `${count} project${count === 1 ? "" : "s"} taken at ${when}${names ? ": " + names : ""}`;
}

/**
 * Restores an instance from a backup.
 *
 * All or nothing: a half-restored instance would be worse than a failed
 * restore, since some projects would exist without their variables.
 */
export async function restoreBackup(store: Store, backup: Backup): Promise<void> {
  if (backup.version !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup version ${backup.version}; this Quai reads version ${FORMAT_VERSION}.`,
    );
  }

  store.transaction(() => {
    for (const project of backup.projects) {
      store.restoreProject(project);

      for (const [key, value] of Object.entries(backup.env[project.name] ?? {})) {
        if (typeof value !== "string") {
          throw new Error(
            `Backup is malformed: ${project.name}.${key} is not a string`,
          );
        }
        store.setEnv(project.name, key, value);
      }

      store.setDomains(project.name, backup.domains[project.name] ?? []);
    }
  });
}

