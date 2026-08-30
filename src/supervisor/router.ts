/**
 * Request routing.
 *
 * The router maps a Host header to a project and serves it. It is written
 * against injected lookups rather than the filesystem so the routing rules can
 * be tested without deploying anything.
 */

import type { HealthReport } from "./health";
import { projectFor } from "./naming";
import { resolveStaticFile } from "./static";

export type ProjectRecord = {
  name: string;
  type: "static" | "function" | "service";
};

export type RouterContext = {
  /** The wildcard zone projects are served under. */
  zone: string;
  health: HealthReport;
  lookup: (project: string) => ProjectRecord | null;
  /** Reads a file, or null when it is absent. */
  readFile: (root: string, path: string) => Promise<string | Uint8Array | null>;
  rootFor: (project: string) => string;
};

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

function contentTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

const notFound = () => new Response("Not found", { status: 404 });

export async function handleRequest(
  request: Request,
  context: RouterContext,
): Promise<Response> {
  const host = request.headers.get("host") ?? "";
  const url = new URL(request.url);
  const project = projectFor(host, context.zone);

  // Operator endpoints live on the bare zone, so a project may still be named
  // "health" without hijacking them.
  if (project === null) {
    const hostname = host.toLowerCase().split(":")[0];
    if (hostname === context.zone.toLowerCase() && url.pathname === "/health") {
      return Response.json(context.health, {
        status: context.health.status === "unhealthy" ? 503 : 200,
      });
    }
    return notFound();
  }

  const record = context.lookup(project);
  if (record === null) return notFound();

  const root = context.rootFor(project);
  const filePath = resolveStaticFile(root, url.pathname);
  if (filePath === null) return notFound();

  const body = await context.readFile(root, filePath);
  if (body === null) return notFound();

  return new Response(body, { headers: { "content-type": contentTypeFor(filePath) } });
}

