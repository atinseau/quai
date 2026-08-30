/**
 * Static file serving.
 *
 * A static project never starts a process: the router resolves a request
 * straight to a file on disk. That is what keeps the most common case at zero
 * memory when idle.
 */

import { resolve } from "node:path";

/**
 * Resolves a request path to a file inside the project directory.
 *
 * Returns null when the request cannot be served safely, so the caller answers
 * 404 rather than leaking why.
 */
export function resolveStaticFile(root: string, requestPath: string): string | null {
  const withoutQuery = requestPath.split("?")[0] ?? "";

  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    // Malformed percent-encoding is a sign of probing, not a real request.
    return null;
  }

  if (decoded.includes("\u0000")) return null;

  // Backslashes are not path separators here, but normalising them prevents a
  // Windows-style traversal from slipping past the resolve() check.
  const normalised = decoded.replace(/\\/g, "/");

  const relative = normalised.endsWith("/") ? normalised + "index.html" : normalised;
  const destination = resolve(root, "." + relative);

  if (destination !== root && !destination.startsWith(root + "/")) return null;

  return destination;
}

