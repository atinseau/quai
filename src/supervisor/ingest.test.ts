import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployArchive, type DeployDeps } from "./ingest";
import { ProjectSupervisor, type RunSpec, type Runner } from "./runner";
import { SiteStore } from "./sites";
import { Store } from "./store";
import { packTar } from "./tar";

const encoder = new TextEncoder();
const entry = (name: string, body: string) => ({ name, contents: encoder.encode(body) });

class RecordingRunner implements Runner {
  readonly started: RunSpec[] = [];
  async start(spec: RunSpec) {
    this.started.push(spec);
    return { project: spec.project, pid: 1, port: spec.internalPort };
  }
  async stop() {}
  async status() {
    return { state: "running" as const, pid: 1 };
  }
}

let deps: DeployDeps;
let runner: RecordingRunner;
let accounts: { project: string; uid: number }[];
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "quai-ingest-"));
  runner = new RecordingRunner();
  accounts = [];
  deps = {
    sites: new SiteStore(join(base, "sites")),
    store: new Store(new Database(":memory:")),
    zone: "quai.example.com",
    projects: new ProjectSupervisor(runner),
    ensureAccount: async (project, uid) => {
      accounts.push({ project, uid });
    },
    homeFor: (project: string) => join(base, "homes", project),
  };
});

const staticSpec = { type: "static" as const };

describe("deploying a static project", () => {
  test("the site becomes readable and the URL is returned", async () => {
    const result = await deployArchive(
      "my-site",
      packTar([entry("index.html", "<h1>hi</h1>")]),
      staticSpec,
      deps,
    );
    expect(result.url).toBe("https://my-site.quai.example.com");
    const body = await readFile(join(deps.sites.rootFor("my-site"), "index.html"), "utf8");
    expect(body).toBe("<h1>hi</h1>");
  });

  test("no process is ever started for a static project", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "hi")]), staticSpec, deps);
    expect(runner.started).toEqual([]);
  });

  test("a project keeps its uid across redeploys", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "v1")]), staticSpec, deps);
    const uid = deps.store.lookup("my-site")!.uid;
    await deployArchive("my-site", packTar([entry("index.html", "v2")]), staticSpec, deps);
    expect(deps.store.lookup("my-site")!.uid).toBe(uid);
  });

  test("redeploying replaces the content without duplicating the project", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "v1")]), staticSpec, deps);
    await deployArchive("my-site", packTar([entry("index.html", "v2")]), staticSpec, deps);
    const body = await readFile(join(deps.sites.rootFor("my-site"), "index.html"), "utf8");
    expect(body).toBe("v2");
    expect(deps.store.list()).toHaveLength(1);
  });

  test("an empty archive is refused rather than publishing an empty site", async () => {
    await expect(deployArchive("s", packTar([]), staticSpec, deps)).rejects.toThrow(/no files/i);
  });

  test("an archive escaping its project is refused", async () => {
    const evil = packTar([entry("../../etc/passwd", "pwned")]);
    await expect(deployArchive("s", evil, staticSpec, deps)).rejects.toThrow(/escape/i);
  });

  test("concurrent deploys never share a uid", async () => {
    await Promise.all([
      deployArchive("alpha", packTar([entry("index.html", "a")]), staticSpec, deps),
      deployArchive("beta", packTar([entry("index.html", "b")]), staticSpec, deps),
    ]);
    expect(new Set(deps.store.list().map((p) => p.uid)).size).toBe(2);
  });
});

describe("deploying a service", () => {
  const serviceSpec = { type: "service" as const, start: "node server.js" };

  test("the service is started after deploying", async () => {
    await deployArchive("api", packTar([entry("server.js", "//")]), serviceSpec, deps);
    expect(runner.started.map((s) => s.project)).toEqual(["api"]);
  });

  test("the service runs under the project's own uid, never root", async () => {
    await deployArchive("api", packTar([entry("server.js", "//")]), serviceSpec, deps);
    expect(runner.started[0]!.uid).toBe(deps.store.lookup("api")!.uid);
    expect(runner.started[0]!.uid).not.toBe(0);
  });

  test("an account is provisioned for the service", async () => {
    await deployArchive("api", packTar([entry("server.js", "//")]), serviceSpec, deps);
    expect(accounts.map((a) => a.project)).toEqual(["api"]);
  });

  test("the start command is recorded, so the service survives a restart", async () => {
    await deployArchive("api", packTar([entry("server.js", "//")]), serviceSpec, deps);
    expect(deps.store.lookup("api")!.command).toBe("node server.js");
  });

  test("a service without a start command is refused", async () => {
    await expect(
      deployArchive("api", packTar([entry("server.js", "//")]), { type: "service" }, deps),
    ).rejects.toThrow(/start command/i);
  });

  test("the declared internal port is used, not guessed", async () => {
    await deployArchive(
      "api",
      packTar([entry("server.js", "//")]),
      { ...serviceSpec, internalPort: 3000 },
      deps,
    );
    expect(runner.started[0]!.internalPort).toBe(3000);
  });

  test("two services may declare the same internal port", async () => {
    // Each gets its own network namespace, so 8080 is not contested.
    await deployArchive("alpha", packTar([entry("s.js", "//")]), serviceSpec, deps);
    await deployArchive("beta", packTar([entry("s.js", "//")]), serviceSpec, deps);
    expect(runner.started.map((s) => s.internalPort)).toEqual([8080, 8080]);
  });

  test("the project's environment variables reach the process", async () => {
    deps.store.upsertProject({ name: "api", type: "service" });
    deps.store.setEnv("api", "NODE_ENV", "production");
    await deployArchive("api", packTar([entry("server.js", "//")]), serviceSpec, deps);
    expect(runner.started[0]!.env).toMatchObject({ NODE_ENV: "production" });
  });
});

