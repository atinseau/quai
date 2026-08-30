/**
 * Quai supervisor, PID 1.
 *
 * Refuses to start when the host cannot enforce project isolation: booting
 * anyway would let projects believe they are contained when they are not.
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createAccount, homeFor, readAccounts } from "./accounts";
import { buildHealthReport } from "./health";
import { deployArchive, type DeploySpec } from "./ingest";
import { LinuxRunner } from "./linux-runner";
import { checkIsolationSupport, formatFailures } from "./preflight";
import { formatReport, reconcile } from "./reconcile";
import { handleRequest } from "./router";
import { ProjectSupervisor } from "./runner";
import { SiteStore } from "./sites";
import { openStore } from "./store";
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
const runner = new LinuxRunner();
const projects = new ProjectSupervisor(runner);

async function chown(path: string, uid: number): Promise<void> {
  const proc = Bun.spawn(["chown", "-R", `${uid}:${uid}`, path], { stderr: "pipe" });
  await proc.exited;
}

const deployDeps = {
  sites,
  store,
  zone: ZONE,
  projects,
  ensureAccount: async (project: string, uid: number) => {
    const accounts = await readAccounts();
    if (!accounts.has(project)) await createAccount(project, uid);
  },
  homeFor,
  chown,
};

// Accounts, cgroups and namespaces do not survive the container being
// recreated, so rebuild them from the database before serving anything.
const report = await reconcile(store.list(), {
  existingAccounts: await readAccounts(),
  existingSites: new Set(await readdir(sitesDirectory).catch(() => [])),
  createAccount,
});
const summary = formatReport(report);
if (summary.length > 0) console.log(summary);

// Services recorded in the database must be running again after a restart.
for (const project of store.list()) {
  if (project.type === "static" || project.command === null) continue;
  await projects
    .start({
      project: project.name,
      uid: project.uid,
      home: homeFor(project.name),
      command: project.command.split(" "),
      internalPort: project.internalPort ?? 8080,
      env: store.getEnv(project.name),
      namespaceIndex: project.netnsIndex,
    })
    .catch((error: Error) =>
      console.error("could not restart " + project.name + ": " + error.message),
    );
}

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

      const spec: DeploySpec = {
        type: (url.searchParams.get("type") as DeploySpec["type"]) ?? "static",
        start: url.searchParams.get("start") ?? undefined,
        internalPort: url.searchParams.has("port")
          ? Number(url.searchParams.get("port"))
          : undefined,
      };

      try {
        const archive = new Uint8Array(await request.arrayBuffer());
        const result = await deployArchive(project, archive, spec, deployDeps);
        return Response.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 400 });
      }
    }

    // Operator view of what is actually running.
    if (url.pathname === "/_quai/status") {
      const states = await Promise.all(
        store.list().map(async (project) => ({
          name: project.name,
          type: project.type,
          uid: project.uid,
          run: await projects.status(project.name),
        })),
      );
      return Response.json(states);
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
      proxy: async (request, target) => {
        const url = new URL(request.url);
        url.protocol = "http:";
        // Reach the service at its own end of the veth pair: its port lives
        // in its namespace, not on the supervisor loopback.
        const address = runner.addressFor(target.project) ?? "127.0.0.1";
        url.host = address + ":" + target.port;
        return fetch(url.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
      },
    });
  },
});

const versions = runtimes.map((r) => `${r.name} ${r.version ?? "absent"}`).join(", ");
console.log(`quai supervisor on :${PORT} — zone ${ZONE} — runtimes: ${versions}`);
console.log(`${store.list().length} project(s) restored`);

