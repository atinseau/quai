/**
 * Static file serving.
 *
 * A static project never starts a process: the router resolves a request
 * straight to a file on disk. That is what keeps the most common case at zero
 * memory when idle.
 *
 * Resolution and content type live together because they are the same
 * decision seen twice: what file answers this request, and how a browser is
 * told to read it. Anything serving a Quai project — the router, or the CLI
 * running one locally — goes through here, so the two cannot drift apart.
 */

import { resolve } from "node:path";

/**
 * Content types by extension.
 *
 * Deliberately a short list rather than a full database: these are what a
 * static site is made of. An unknown extension is served as an opaque
 * download, which is safer than guessing.
 */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

/** How a browser should be told to read a file. */
export function contentTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

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
