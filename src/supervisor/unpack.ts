/**
 * Deploy archive handling.
 *
 * An uploaded tar is untrusted input: entry names can try to escape the
 * project directory. Every destination is resolved and checked before a byte
 * is written.
 */

import { isAbsolute, resolve } from "node:path";

/**
 * Resolves where an archive entry may be written.
 *
 * @throws when the entry would land outside the project root.
 */
export function safeExtractPath(root: string, entryName: string): string {
  if (entryName.length === 0) {
    throw new Error("Archive entry has an empty name");
  }
  if (isAbsolute(entryName)) {
    throw new Error(`Archive entry "${entryName}" is an absolute path`);
  }

  const destination = resolve(root, entryName);

  // Comparing against root + "/" matters: a bare prefix check would accept a
  // sibling directory whose name merely starts with the root.
  if (destination !== root && !destination.startsWith(root + "/")) {
    throw new Error(`Archive entry "${entryName}" would escape the project directory`);
  }

  return destination;
}
