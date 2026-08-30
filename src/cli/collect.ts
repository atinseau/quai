/**
 * Collecting a directory for deployment.
 *
 * The client decides what ships. Files that would only bloat the upload — VCS
 * metadata, dependency trees, local env files — are left behind, and secrets
 * are never uploaded by accident.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { TarEntry } from "../supervisor/tar";

const SKIPPED = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".DS_Store",
  ".env",
  ".env.local",
  "quai.toml",
]);

export function isSkipped(name: string): boolean {
  return SKIPPED.has(name);
}

/** Reads every deployable file under a directory, relative to it. */
export async function collectFiles(directory: string): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];

  async function walk(current: string): Promise<void> {
    for (const name of await readdir(current)) {
      if (isSkipped(name)) continue;

      const absolute = join(current, name);
      const info = await stat(absolute);

      if (info.isDirectory()) {
        await walk(absolute);
      } else if (info.isFile()) {
        entries.push({
          name: relative(directory, absolute),
          contents: new Uint8Array(await readFile(absolute)),
        });
      }
    }
  }

  await walk(directory);
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

