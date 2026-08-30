/**
 * Quai supervisor, PID 1.
 *
 * Refuses to start when the host cannot enforce project isolation: booting
 * anyway would let projects believe they are contained when they are not.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createAccount,
  homeFor,
  prepareHome,
  readAccounts,
  removeAccount,
} from "./accounts";
import { buildHealthReport } from "./health";
import { deployArchive, type DeploySpec } from "./ingest";
import { LinuxRunner, SECCOMP_POLICY_PATH } from "./linux-runner";
import { SeccompProfile } from "./seccomp";
import { checkIsolationSupport, formatFailures } from "./preflight";
import { formatReport, reconcile } from "./reconcile";
import { handleRequest } from "./router";
import { ProjectSupervisor } from "./runner";
import { SiteStore } from "./sites";
import { openStore } from "./store";
import { ProjectQuota } from "./quota";
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

// The policy is rendered to disk so nsjail can read it, and so an operator
// can audit exactly what is enforced.
await mkdir(dirname(SECCOMP_POLICY_PATH), { recursive: true });
await writeFile(SECCOMP_POLICY_PATH, new SeccompProfile().policy());

const sites = new SiteStore(sitesDirectory);
const store = openStore(join(STATE, "quai.db"));
const runner = new LinuxRunner();
const projects = new ProjectSupervisor(runner);

async function runCommand(argv: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { ok: proc.exitCode === 0, stderr: stderr.trim() };
}

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
    await prepareHome(project, uid);
  },
  homeFor,
  /**
   * Unpacks beside the home, then swaps: the project owns its home and could
   * have left a symlink there, which the supervisor would follow as root.
   */
  replaceTree: async (staging: string, build: () => Promise<void>) => {
    const target = staging.replace(/\.incoming$/, "");
    const previous = target + ".previous";

    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    try {
      await build();
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }

    await rm(previous, { recursive: true, force: true });
    await rename(target, previous).catch(() => {});
    await rename(staging, target);
    await rm(previous, { recursive: true, force: true });
  },
  chown,
  applyQuota: async (project: string, uid: number, limit: string) => {
    // The quota follows the content: a static project keeps its files under
    // sites/, a service in its own home. Capping the wrong one leaves the
    // project on quota project 0, where no limit applies.
    const staticPath = join(sitesDirectory, project);
    const contentPath = existsSync(staticPath) ? staticPath : homeFor(project);
    const quota = new ProjectQuota(HOMES, project, uid, contentPath);
    // Only a static project keeps content here; creating the directory for a
    // service would leave an empty one that muddies what is actually deployed.
    if (!existsSync(quota.directory)) return;

    for (const command of quota.applyCommands(limit)) {
      const result = await runCommand(command);
      if (!result.ok) {
        // Refusing the deploy is right: without a quota the project could fill
        // the volume every other project depends on.
        throw new Error(
          "Could not apply the disk quota for '" + project + "': " + result.stderr,
        );
      }
    }
  },
};

// Accounts, cgroups and namespaces do not survive the container being
// recreated, so rebuild them from the database before serving anything.
const report = await reconcile(store.list(), {
  existingAccounts: await readAccounts(),
  existingSites: new Set(await readdir(sitesDirectory).catch(() => [])),
  createAccount: async (project: string, uid: number) => {
    await createAccount(project, uid);
    await prepareHome(project, uid);
  },
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
        runtime: (url.searchParams.get("runtime") as DeploySpec["runtime"]) ?? undefined,
        internalPort: url.searchParams.has("port")
          ? Number(url.searchParams.get("port"))
          : undefined,
        timeoutSeconds: url.searchParams.has("timeout")
          ? Number(url.searchParams.get("timeout"))
          : undefined,
      };

      try {
        const archive = new Uint8Array(await request.arrayBuffer());
        const result = await deployArchive(project, archive, spec, deployDeps);

        // Custom domains are declared in quai.toml and replace the previous
        // set, so dropping one from the manifest retires it on the next deploy.
        const declared = url.searchParams.get("domains");
        if (declared !== null) {
          store.setDomains(project, declared.split(",").filter(Boolean));
        }
        return Response.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 400 });
      }
    }

    // Project administration, reached through the same authenticated channel
    // as deploys: these endpoints are never part of the public routing surface.
    if (url.pathname.startsWith("/_quai/") && url.pathname !== "/_quai/deploy") {
      if (!DEPLOY_TOKEN || request.headers.get("x-quai-token") !== DEPLOY_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const project = url.searchParams.get("project") ?? "";

      if (url.pathname === "/_quai/env") {
        if (store.lookup(project) === null) {
          return Response.json({ error: "No such project" }, { status: 404 });
        }

        if (request.method === "GET") return Response.json(store.getEnv(project));

        if (request.method === "POST") {
          const body = (await request.json()) as { set?: Record<string, string>; unset?: string[] };
          store.transaction(() => {
            for (const [key, value] of Object.entries(body.set ?? {})) {
              store.setEnv(project, key, value);
            }
            for (const key of body.unset ?? []) store.unsetEnv(project, key);
          });
          return Response.json(store.getEnv(project));
        }
      }

      if (url.pathname === "/_quai/logs") {
        const lines = projects.logsFor(project);
        if (lines === null) {
          return Response.json({ error: "No such running project" }, { status: 404 });
        }
        return new Response(lines, { headers: { "content-type": "text/plain" } });
      }

      if (url.pathname === "/_quai/domains" && request.method === "POST") {
        const body = (await request.json()) as { domains?: string[] };
        store.setDomains(project, body.domains ?? []);
        return Response.json({ domains: store.domainsFor(project) });
      }

      if (url.pathname === "/_quai/remove" && request.method === "POST") {
        if (store.lookup(project) === null) {
          return Response.json({ error: "No such project" }, { status: 404 });
        }

        // Order matters: stop the process before removing what it runs on, so
        // nothing is left holding a deleted home.
        await projects.stop(project);

        // Release the quota before the content disappears, so the limit does
        // not linger against a project id that no longer exists.
        const record = store.lookup(project);
        if (record !== null) {
          const quota = new ProjectQuota(HOMES, project, record.uid, homeFor(project));
          for (const command of quota.releaseCommands()) await runCommand(command);
        }

        await sites.remove(project);
        await removeAccount(project);
        store.removeProject(project);

        return Response.json({ removed: project });
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
          seccompPolicy: SECCOMP_POLICY_PATH,
        })),
      );
      return Response.json(states);
    }

    return handleRequest(request, {
      zone: ZONE,
      health,
      lookup: (project) => store.lookup(project),
      projectForDomain: (domain) => store.projectForDomain(domain),
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

