import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployArchive } from "./ingest";
import { SiteStore } from "./sites";
import { Store } from "./store";
import { packTar } from "./tar";

const encoder = new TextEncoder();
const entry = (name: string, body: string) => ({ name, contents: encoder.encode(body) });

let deps: { sites: SiteStore; store: Store; zone: string };
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "quai-ingest-"));
  deps = {
    sites: new SiteStore(join(base, "sites")),
    store: new Store(new Database(":memory:")),
    zone: "quai.example.com",
  };
});

describe("deploying an archive", () => {
  test("the site becomes readable and the URL is returned", async () => {
    const result = await deployArchive(
      "my-site",
      packTar([entry("index.html", "<h1>hi</h1>")]),
      deps,
    );
    expect(result.url).toBe("https://my-site.quai.example.com");
    const body = await readFile(join(deps.sites.rootFor("my-site"), "index.html"), "utf8");
    expect(body).toBe("<h1>hi</h1>");
  });

  test("the project becomes routable", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "hi")]), deps);
    expect(deps.store.lookup("my-site")).toMatchObject({ name: "my-site", type: "static" });
  });

  test("a static deploy is recorded as static, so no process is ever started", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "hi")]), deps);
    expect(deps.store.lookup("my-site")!.type).toBe("static");
  });

  test("a project keeps its uid across redeploys", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "v1")]), deps);
    const uid = deps.store.lookup("my-site")!.uid;
    await deployArchive("my-site", packTar([entry("index.html", "v2")]), deps);
    expect(deps.store.lookup("my-site")!.uid).toBe(uid);
  });

  test("redeploying replaces the content without duplicating the project", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "v1")]), deps);
    await deployArchive("my-site", packTar([entry("index.html", "v2")]), deps);
    const body = await readFile(join(deps.sites.rootFor("my-site"), "index.html"), "utf8");
    expect(body).toBe("v2");
    expect(deps.store.list()).toHaveLength(1);
  });

  test("an empty archive is refused rather than publishing an empty site", async () => {
    await expect(deployArchive("my-site", packTar([]), deps)).rejects.toThrow(/no files/i);
  });

  test("an archive escaping its project is refused", async () => {
    const evil = packTar([entry("../../etc/passwd", "pwned")]);
    await expect(deployArchive("my-site", evil, deps)).rejects.toThrow(/escape/i);
  });

  test("a refused deploy does not register the project", async () => {
    await deployArchive("my-site", packTar([entry("../evil", "x")]), deps).catch(() => {});
    expect(deps.store.lookup("my-site")).toBeNull();
  });

  test("concurrent deploys of different projects both land", async () => {
    await Promise.all([
      deployArchive("alpha", packTar([entry("index.html", "a")]), deps),
      deployArchive("beta", packTar([entry("index.html", "b")]), deps),
    ]);
    expect(deps.store.list().map((p) => p.name)).toEqual(["alpha", "beta"]);
  });

  test("concurrent deploys never share a uid", async () => {
    await Promise.all([
      deployArchive("alpha", packTar([entry("index.html", "a")]), deps),
      deployArchive("beta", packTar([entry("index.html", "b")]), deps),
    ]);
    const uids = deps.store.list().map((p) => p.uid);
    expect(new Set(uids).size).toBe(2);
  });
});

