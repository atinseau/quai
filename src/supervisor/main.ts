/**
 * Quai supervisor, PID 1.
 *
 * Refuses to start when the host cannot enforce project isolation: booting
 * anyway would let projects believe they are contained when they are not.
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { buildHealthReport } from "./health";
import { deployArchive } from "./ingest";
import { checkIsolationSupport, formatFailures } from "./preflight";
import { formatReport, reconcile } from "./reconcile";
import { handleRequest } from "./router";
import { SiteStore } from "./sites";
import { openStore } from "./store";
import { readAccounts, createAccount } from "./accounts";
import { readRuntimes, readSystem } from "./system";

const HOMES = process.env.QUAI_HOMES ?? "/srv/quai/homes";
const STATE = process.env.QUAI_STATE ?? "/srv/quai/state";
const ZONE = process.env.QUAI_ZONE ?? "quai.localhost";
const PORT = Number(process.env.QUAI_PORT ?? 8080);
const DEPLOY_TOKEN = process.env.QUAI_DEPLOY_TOKEN ?? "";

const isolation = checkIsolationSupport(await readSystem(HOMES));
const runtimes = await readRuntimes();

if (!isolation.supported) {
  console.error(formatFailures(isolation.failures));
  process.exit(1);
}

const sitesDirectory = join(HOMES, "sites");
await mkdir(sitesDirectory, { recursive: true });
await mkdir(STATE, { recursive: true });

const sites = new SiteStore(sitesDirectory);
const store = openStore(join(STATE, "quai.db"));

// Accounts, cgroups and namespaces do not survive the container being
// recreated, so rebuild them from the database before serving anything.
const report = await reconcile(store.list(), {
  existingAccounts: await readAccounts(),
  existingSites: new Set(await readdir(sitesDirectory).catch(() => [])),
  createAccount,
});
const summary = formatReport(report);
if (summary.length > 0) console.log(summary);

const health = buildHealthReport({ isolation, runtimes });

Bun.serve({
  port: PORT,
  maxRequestBodySize: 512 * 1024 * 1024,

  async fetch(request) {
    const url = new URL(request.url);

    // The deploy endpoint is reached through the SSH forced command, which
    // supplies the token; it is never part of the public routing surface.
    if (request.method === "POST" && url.pathname === "/_quai/deploy") {
      if (!DEPLOY_TOKEN || request.headers.get("x-quai-token") !== DEPLOY_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const project = url.searchParams.get("project") ?? "";
      if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) {
        return Response.json({ error: "Invalid project name" }, { status: 400 });
      }

      try {
        const archive = new Uint8Array(await request.arrayBuffer());
        const result = await deployArchive(project, archive, { sites, store, zone: ZONE });
        return Response.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 400 });
      }
    }

    return handleRequest(request, {
      zone: ZONE,
      health,
      lookup: (project) => store.lookup(project),
      rootFor: (project) => sites.rootFor(project),
      readFile: async (_root, path) => {
        try {
          return new Uint8Array(await readFile(path));
        } catch {
          return null;
        }
      },
    });
  },
});

const versions = runtimes.map((r) => `${r.name} ${r.version ?? "absent"}`).join(", ");
console.log(`quai supervisor on :${PORT} — zone ${ZONE} — runtimes: ${versions}`);
console.log(`${store.list().length} project(s) restored`);

