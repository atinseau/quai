/**
 * Updating and removing the CLI itself.
 *
 * The delicate part is that "quai update" replaces the very file it is running
 * from. A program's binary cannot simply be overwritten while it executes, so
 * the old one is renamed aside — which keeps its inode alive until the process
 * exits — and the new one takes its place.
 */

import { chmod, rename, rm, stat } from "node:fs/promises";

/**
 * Puts `staged` where `current` is, safely, while `current` is executing.
 *
 * @returns the path the previous binary was moved to.
 * @throws leaving the working binary untouched: half-updating the tool that
 * performs updates would leave no way out but a manual reinstall.
 */
export async function replaceRunningBinary(
  current: string,
  staged: string,
): Promise<string> {
  // Fail before touching anything if the download is not actually there.
  await stat(staged);

  const backup = current + ".old";
  // A previous update may have left one behind; it is stale by definition.
  await rm(backup, { force: true });

  await rename(current, backup);

  try {
    await rename(staged, current);
    await chmod(current, 0o755);
  } catch (error) {
    // Put the working binary back rather than leave the user with nothing.
    await rename(backup, current).catch(() => {});
    throw error;
  }

  return backup;
}

export type UninstallPlan = { binary: string; config: string };

/**
 * What "quai uninstall" removes.
 *
 * Deliberately just these two: uninstalling a CLI must never reach a user's
 * projects or the deployments living on a server.
 */
export function uninstallPlan(binary: string, config: string): UninstallPlan {
  return { binary, config };
}

