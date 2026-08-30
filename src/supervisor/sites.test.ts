import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteStore } from "./sites";

const encoder = new TextEncoder();
const entry = (name: string, body: string) => ({ name, contents: encoder.encode(body) });

let store: SiteStore;
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "quai-sites-"));
  store = new SiteStore(base);
});

describe("site store", () => {
  test("a published site is readable at its root", async () => {
    await store.publish("my-site", [entry("index.html", "<h1>v1</h1>")]);
    const body = await readFile(join(store.rootFor("my-site"), "index.html"), "utf8");
    expect(body).toBe("<h1>v1</h1>");
  });

  test("nested files keep their structure", async () => {
    await store.publish("my-site", [entry("assets/app.css", "body{}")]);
    const body = await readFile(join(store.rootFor("my-site"), "assets/app.css"), "utf8");
    expect(body).toBe("body{}");
  });

  test("redeploying updates the content in place", async () => {
    await store.publish("my-site", [entry("index.html", "<h1>v1</h1>")]);
    await store.publish("my-site", [entry("index.html", "<h1>v2</h1>")]);
    const body = await readFile(join(store.rootFor("my-site"), "index.html"), "utf8");
    expect(body).toBe("<h1>v2</h1>");
  });

  test("redeploying creates no duplicate directory", async () => {
    await store.publish("my-site", [entry("index.html", "v1")]);
    await store.publish("my-site", [entry("index.html", "v2")]);
    expect(await readdir(base)).toEqual(["my-site"]);
  });

  test("a file removed from the source disappears from the deploy", async () => {
    await store.publish("my-site", [entry("index.html", "v1"), entry("old.css", "x")]);
    await store.publish("my-site", [entry("index.html", "v2")]);
    expect(await readdir(store.rootFor("my-site"))).toEqual(["index.html"]);
  });

  test("a failed deploy leaves the previous site serving", async () => {
    await store.publish("my-site", [entry("index.html", "v1")]);
    await store.publish("my-site", [entry("../evil", "x")]).catch(() => {});
    const body = await readFile(join(store.rootFor("my-site"), "index.html"), "utf8");
    expect(body).toBe("v1");
  });

  test("an archive escaping its project is refused", async () => {
    await expect(
      store.publish("my-site", [entry("../../etc/passwd", "pwned")]),
    ).rejects.toThrow(/escape/i);
  });

  test("a failed deploy leaves no staging directory behind", async () => {
    // Otherwise a rejected upload would silently accumulate junk next to the
    // live sites, and the next deploy would inherit its leftovers.
    await store.publish("my-site", [entry("index.html", "v1")]);
    await store.publish("my-site", [entry("../evil", "x")]).catch(() => {});
    const remaining = await readdir(base);
    expect(remaining.some((name) => name.endsWith(".incoming"))).toBe(false);
  });

  test("removing a project deletes its content", async () => {
    await store.publish("my-site", [entry("index.html", "v1")]);
    await store.remove("my-site");
    expect(await readdir(base)).toEqual([]);
  });

  test("two projects do not share storage", async () => {
    await store.publish("alpha", [entry("index.html", "a")]);
    await store.publish("beta", [entry("index.html", "b")]);
    const a = await readFile(join(store.rootFor("alpha"), "index.html"), "utf8");
    expect(a).toBe("a");
  });
});

