/**
 * Request routing.
 *
 * The router maps a Host header to a project and serves it: files straight
 * from disk for a static project, a proxied request into its namespace for a
 * service. It is written against injected lookups rather than the filesystem
 * so the routing rules can be tested without deploying anything.
 */

import type { HealthReport } from "./health";
import { projectFor } from "./naming";
import { contentTypeFor, resolveStaticFile } from "./static";

export type ProjectRecord = {
  name: string;
  type: "static" | "function" | "service";
  /** The port a service listens on inside its own network namespace. */
  internalPort?: number | null;
};

/** Where a proxied request should be delivered. */
export type ProxyTarget = { project: string; port: number };

export type RouterContext = {
  /** The wildcard zone projects are served under. */
  zone: string;
  health: HealthReport;
  lookup: (project: string) => ProjectRecord | null;
  /** Reads a file, or null when it is absent. */
  readFile: (root: string, path: string) => Promise<string | Uint8Array | null>;
  rootFor: (project: string) => string;
  /** Forwards a request into a project's namespace. */
  /** Resolves a custom domain to its project, if any. */
  projectForDomain?: (domain: string) => string | null;
  proxy: (request: Request, target: ProxyTarget) => Promise<Response>;
};

const notFound = () => new Response("Not found", { status: 404 });

export async function handleRequest(request: Request, context: RouterContext): Promise<Response> {
  const host = request.headers.get("host") ?? "";
  const url = new URL(request.url);
  const hostname = host.toLowerCase().split(":")[0] ?? "";

  // A project's subdomain always wins; a custom domain is consulted only for
  // hosts outside the zone, so no project can claim the zone itself.
  const project =
    projectFor(host, context.zone) ??
    (hostname === context.zone.toLowerCase()
      ? null
      : (context.projectForDomain?.(hostname) ?? null));

  // Operator endpoints live on the bare zone, so a project may still be named
  // "health" without hijacking them.
  if (project === null) {
    if (hostname === context.zone.toLowerCase() && url.pathname === "/health") {
      return Response.json(context.health, {
        status: context.health.status === "unhealthy" ? 503 : 200,
      });
    }
    return notFound();
  }

  const record = context.lookup(project);
  if (record === null) return notFound();

  if (record.type === "service" || record.type === "function") {
    try {
      return await context.proxy(request, {
        project,
        port: record.internalPort ?? 8080,
      });
    } catch {
      // 404 would claim the project does not exist. 502 says it exists but is
      // not answering, which is what an operator needs to know.
      return new Response("Bad gateway: the project is not responding", { status: 502 });
    }
  }

  const root = context.rootFor(project);
  const filePath = resolveStaticFile(root, url.pathname);
  if (filePath === null) return notFound();

  const body = await context.readFile(root, filePath);
  if (body === null) return notFound();

  return new Response(body, { headers: { "content-type": contentTypeFor(filePath) } });
}
