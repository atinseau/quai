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
    replaceTree: async (staging: string, build: () => Promise<void>) => {
      const { mkdir, rename, rm } = await import("node:fs/promises");
      const target = staging.replace(/\.incoming$/, "");
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      await build();
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    },
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


describe("disk quota on deploy", () => {
  test("a quota is applied to every project", async () => {
    const applied: { project: string; limit: string }[] = [];
    await deployArchive("my-site", packTar([entry("index.html", "hi")]), staticSpec, {
      ...deps,
      applyQuota: async (project, _uid, limit) => {
        applied.push({ project, limit });
      },
    });
    expect(applied).toEqual([{ project: "my-site", limit: "1Gi" }]);
  });

  test("the quota is applied after publication, since a rename drops the mark", async () => {
    // An atomic publish renames the directory into place, and the project
    // attribute does not survive the rename. Marking first silently leaves the
    // content uncapped on project 0 — observed in the container.
    const order: string[] = [];
    await deployArchive("my-site", packTar([entry("index.html", "hi")]), staticSpec, {
      ...deps,
      applyQuota: async () => {
        order.push("quota");
      },
      sites: {
        rootFor: (project: string) => deps.sites.rootFor(project),
        publish: async () => {
          order.push("publish");
        },
        remove: async () => {},
      },
    });
    expect(order).toEqual(["publish", "quota"]);
  });

  test("the quota is keyed on the project's uid", async () => {
    let seenUid = -1;
    await deployArchive("my-site", packTar([entry("index.html", "hi")]), staticSpec, {
      ...deps,
      applyQuota: async (_project, uid) => {
        seenUid = uid;
      },
    });
    expect(seenUid).toBe(deps.store.lookup("my-site")!.uid);
  });

  test("deploying still works where quotas are unavailable", async () => {
    // Tests and non-XFS hosts have no quota support; the deploy must not fail.
    const result = await deployArchive(
      "my-site",
      packTar([entry("index.html", "hi")]),
      staticSpec,
      { ...deps, applyQuota: undefined },
    );
    expect(result.project).toBe("my-site");
  });
});


describe("deploying a function", () => {
  const fn = { type: "function" as const, start: "api.js", runtime: "node" as const };

  test("a handler is deployed without declaring a command line", () => {
    // The developer names a file; Quai supplies the host that serves it.
    expect(async () => {
      await deployArchive("fn", packTar([entry("api.js", "export default () => {}")]), fn, deps);
    }).not.toThrow();
  });

  test("the function is served by a host, not run directly", async () => {
    await deployArchive("fn", packTar([entry("api.js", "//")]), fn, deps);
    expect(runner.started[0]!.command.join(" ")).toContain("node-host");
  });

  test("the handler path reaches the host through the environment", async () => {
    await deployArchive("fn", packTar([entry("api.js", "//")]), fn, deps);
    expect(runner.started[0]!.env.QUAI_HANDLER).toBe("api.js");
  });

  test("the timeout reaches the host", async () => {
    await deployArchive(
      "fn",
      packTar([entry("api.js", "//")]),
      { ...fn, timeoutSeconds: 45 },
      deps,
    );
    expect(runner.started[0]!.env.QUAI_TIMEOUT_MS).toBe("45000");
  });

  test("each runtime gets its own host", async () => {
    await deployArchive("py", packTar([entry("main.py", "#")]), {
      type: "function",
      start: "main.py",
      runtime: "python",
    }, deps);
    expect(runner.started[0]!.command.join(" ")).toContain("python_host");
  });

  test("the project's own variables survive alongside the host's", async () => {
    deps.store.upsertProject({ name: "fn", type: "function" });
    deps.store.setEnv("fn", "API_KEY", "secret");
    await deployArchive("fn", packTar([entry("api.js", "//")]), fn, deps);
    expect(runner.started[0]!.env).toMatchObject({
      API_KEY: "secret",
      QUAI_HANDLER: "api.js",
    });
  });

  test("a function is recorded as a function, so it is restored as one", async () => {
    await deployArchive("fn", packTar([entry("api.js", "//")]), fn, deps);
    expect(deps.store.lookup("fn")!.type).toBe("function");
  });
});


describe("functions survive a restart", () => {
  const fn = { type: "function" as const, start: "api.js", runtime: "node" as const };

  test("the handler is persisted, not only passed to the first launch", async () => {
    // The host reads QUAI_HANDLER from the environment. Without persisting it,
    // a restart relaunches the host with no handler to serve — observed in the
    // container, where Node and Bun functions came back dead.
    await deployArchive("fn", packTar([entry("api.js", "//")]), fn, deps);
    expect(deps.store.getEnv("fn").QUAI_HANDLER).toBe("api.js");
  });

  test("the timeout is persisted too", async () => {
    await deployArchive("fn", packTar([entry("api.js", "//")]), { ...fn, timeoutSeconds: 45 }, deps);
    expect(deps.store.getEnv("fn").QUAI_TIMEOUT_MS).toBe("45000");
  });

  test("the recorded command is enough to relaunch the host", async () => {
    await deployArchive("fn", packTar([entry("api.js", "//")]), fn, deps);
    expect(deps.store.lookup("fn")!.command).toContain("node-host");
  });

  test("a project's own variables are not clobbered by the host's", async () => {
    deps.store.upsertProject({ name: "fn", type: "function" });
    deps.store.setEnv("fn", "API_KEY", "secret");
    await deployArchive("fn", packTar([entry("api.js", "//")]), fn, deps);
    expect(deps.store.getEnv("fn")).toMatchObject({
      API_KEY: "secret",
      QUAI_HANDLER: "api.js",
    });
  });
});


describe("storage hygiene", () => {
  test("a service leaves no empty site directory behind", async () => {
    // Its content lives in the project's home, not under sites/. An empty
    // directory here would muddy what is actually deployed.
    const applied: string[] = [];
    await deployArchive(
      "api",
      packTar([entry("server.js", "//")]),
      { type: "service", start: "node server.js" },
      { ...deps, applyQuota: async (project) => { applied.push(project); } },
    );
    const { readdir } = await import("node:fs/promises");
    const sites = await readdir(join(base, "sites")).catch(() => []);
    expect(sites).not.toContain("api");
  });

  test("a static project still gets its directory", async () => {
    await deployArchive("site", packTar([entry("index.html", "hi")]), staticSpec, deps);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(base, "sites"))).toContain("site");
  });
});


describe("a redeploy cannot be redirected by the project", () => {
  const service = { type: "service" as const, start: "node server.js" };

  test("content is unpacked into a fresh tree, never over the previous one", async () => {
    // The project owns its home between deploys and could leave a symlink
    // there. Writing over it would make the supervisor follow it as root and
    // write wherever it points.
    const staged: string[] = [];
    await deployArchive("api", packTar([entry("server.js", "//")]), service, {
      ...deps,
      replaceTree: async (staging, build) => {
        staged.push(staging);
        const { mkdir } = await import("node:fs/promises");
        await mkdir(staging, { recursive: true });
        await build();
      },
    });
    expect(staged[0]!.endsWith(".incoming")).toBe(true);
  });

  test("a symlink left by a previous deploy is not followed", async () => {
    const { mkdir, symlink, readFile, writeFile } = await import("node:fs/promises");
    const outside = join(base, "outside.txt");
    await writeFile(outside, "untouched");

    const home = join(base, "homes", "api");
    await mkdir(home, { recursive: true });
    await symlink(outside, join(home, "server.js"));

    await deployArchive("api", packTar([entry("server.js", "// new code")]), service, deps);

    // The file the symlink pointed at must be exactly as it was.
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });

  test("the new deploy is what actually lands in the home", async () => {
    const { readFile } = await import("node:fs/promises");
    await deployArchive("api", packTar([entry("server.js", "// new code")]), service, deps);
    expect(await readFile(join(base, "homes", "api", "server.js"), "utf8")).toBe("// new code");
  });

  test("a file the project no longer ships disappears", async () => {
    const { readdir } = await import("node:fs/promises");
    await deployArchive("api", packTar([entry("server.js", "//"), entry("old.js", "//")]), service, deps);
    await deployArchive("api", packTar([entry("server.js", "//")]), service, deps);
    expect(await readdir(join(base, "homes", "api"))).toEqual(["server.js"]);
  });
});


describe("declared limits reach the process", () => {
  const service = { type: "service" as const, start: "node server.js" };

  test("a declared memory limit is applied, not the default", async () => {
    // Without this the quai.toml is decorative: a project asking for 512Mi
    // silently runs on the default.
    await deployArchive("api", packTar([entry("server.js", "//")]), {
      ...service,
      limits: { memory: "512Mi" },
    }, deps);
    expect(runner.started[0]!.limits?.memory).toBe("512Mi");
  });

  test("declared cpu and pids limits are applied", async () => {
    await deployArchive("api", packTar([entry("server.js", "//")]), {
      ...service,
      limits: { cpu: "2", pids: 128 },
    }, deps);
    expect(runner.started[0]!.limits).toMatchObject({ cpu: "2", pids: 128 });
  });

  test("an undeclared limit falls back to the default", async () => {
    await deployArchive("api", packTar([entry("server.js", "//")]), service, deps);
    expect(runner.started[0]!.limits?.memory).toBe("256Mi");
  });

  test("a declared disk quota is applied", async () => {
    let seen = "";
    await deployArchive("api", packTar([entry("server.js", "//")]), {
      ...service,
      diskQuota: "5Gi",
    }, { ...deps, applyQuota: async (_p, _u, limit) => { seen = limit; } });
    expect(seen).toBe("5Gi");
  });

  test("an undeclared quota falls back to the default", async () => {
    let seen = "";
    await deployArchive("api", packTar([entry("server.js", "//")]), service, {
      ...deps,
      applyQuota: async (_p, _u, limit) => { seen = limit; },
    });
    expect(seen).toBe("1Gi");
  });
});

