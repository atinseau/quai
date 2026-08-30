import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployArchive } from "./ingest";
import { Registry } from "./registry";
import { SiteStore } from "./sites";
import { packTar } from "./tar";

const encoder = new TextEncoder();
const entry = (name: string, body: string) => ({ name, contents: encoder.encode(body) });

let deps: { store: SiteStore; registry: Registry; zone: string };
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "quai-ingest-"));
  const registry = new Registry(join(base, "state.json"));
  await registry.load();
  deps = { store: new SiteStore(join(base, "sites")), registry, zone: "quai.example.com" };
});

describe("deploying an archive", () => {
  test("the site becomes readable and the URL is returned", async () => {
    const result = await deployArchive(
      "my-site",
      packTar([entry("index.html", "<h1>hi</h1>")]),
      deps,
    );
    expect(result.url).toBe("https://my-site.quai.example.com");
    const body = await readFile(join(deps.store.rootFor("my-site"), "index.html"), "utf8");
    expect(body).toBe("<h1>hi</h1>");
  });

  test("the project becomes routable", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "hi")]), deps);
    expect(deps.registry.lookup("my-site")).toMatchObject({ name: "my-site", type: "static" });
  });

  test("a static deploy is recorded as static, so no process is ever started", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "hi")]), deps);
    expect(deps.registry.lookup("my-site")!.type).toBe("static");
  });

  test("redeploying replaces the content without duplicating the project", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "v1")]), deps);
    await deployArchive("my-site", packTar([entry("index.html", "v2")]), deps);
    const body = await readFile(join(deps.store.rootFor("my-site"), "index.html"), "utf8");
    expect(body).toBe("v2");
    expect(deps.registry.list()).toHaveLength(1);
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
    expect(deps.registry.lookup("my-site")).toBeNull();
  });

  test("the registry survives a reload, so projects outlive a restart", async () => {
    await deployArchive("my-site", packTar([entry("index.html", "hi")]), deps);
    const reloaded = new Registry(join(base, "state.json"));
    await reloaded.load();
    expect(reloaded.lookup("my-site")).toMatchObject({ name: "my-site" });
  });
});

