/**
 * Site storage.
 *
 * A deploy is atomic: the archive is unpacked into a fresh directory and only
 * then swapped into place, so a visitor never sees a half-written site and a
 * failed deploy leaves the previous one serving.
 */

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeExtractPath } from "./unpack";

export type StoredEntry = { name: string; contents: Uint8Array };

export class SiteStore {
  constructor(private readonly baseDirectory: string) {}

  rootFor(project: string): string {
    return join(this.baseDirectory, project);
  }

  /**
   * Replaces a project's content with the given entries.
   *
   * Redeploying the same project overwrites in place rather than accumulating
   * copies, which is what makes a bare "quai" idempotent.
   */
  async publish(project: string, entries: StoredEntry[]): Promise<void> {
    const target = this.rootFor(project);
    const staging = target + ".incoming";
    const previous = target + ".previous";

    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    try {
      for (const entry of entries) {
        const destination = safeExtractPath(staging, entry.name);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, entry.contents);
      }
    } catch (error) {
      // Leave nothing half-written beside the live sites, and keep the
      // previous deploy serving untouched.
      await rm(staging, { recursive: true, force: true });
      throw error;
    }

    // Swap through a temporary name so the window where the site is absent is
    // as short as a rename.
    await rm(previous, { recursive: true, force: true });
    try {
      await rename(target, previous);
    } catch {
      // No previous deploy; nothing to move aside.
    }
    await rename(staging, target);
    await rm(previous, { recursive: true, force: true });
  }

  async remove(project: string): Promise<void> {
    await rm(this.rootFor(project), { recursive: true, force: true });
  }
}

