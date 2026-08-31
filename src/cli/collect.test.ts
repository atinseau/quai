import { describe, expect, test, beforeEach } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, isSkipped } from "./collect";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quai-collect-"));
});

describe("collecting a directory", () => {
  test("files are collected with paths relative to the directory", async () => {
    await writeFile(join(dir, "index.html"), "hi");
    const files = await collectFiles(dir);
    expect(files.map((f) => f.name)).toEqual(["index.html"]);
  });

  test("nested directories are walked", async () => {
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "app.css"), "body{}");
    const files = await collectFiles(dir);
    expect(files.map((f) => f.name)).toEqual([join("assets", "app.css")]);
  });

  test("node_modules is left behind, so uploads stay small", async () => {
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "index.js"), "x");
    await writeFile(join(dir, "index.html"), "hi");
    const files = await collectFiles(dir);
    expect(files.map((f) => f.name)).toEqual(["index.html"]);
  });

  test("git metadata is left behind", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), "x");
    await writeFile(join(dir, "index.html"), "hi");
    expect((await collectFiles(dir)).map((f) => f.name)).toEqual(["index.html"]);
  });

  test("a local .env is never uploaded, so secrets do not leak by accident", async () => {
    await writeFile(join(dir, ".env"), "SECRET=x");
    await writeFile(join(dir, "index.html"), "hi");
    expect((await collectFiles(dir)).map((f) => f.name)).toEqual(["index.html"]);
  });

  test("file contents are preserved", async () => {
    await writeFile(join(dir, "index.html"), "<h1>hello</h1>");
    const [file] = await collectFiles(dir);
    expect(new TextDecoder().decode(file!.contents)).toBe("<h1>hello</h1>");
  });

  test("the order is stable, so identical directories produce identical uploads", async () => {
    await writeFile(join(dir, "b.txt"), "b");
    await writeFile(join(dir, "a.txt"), "a");
    expect((await collectFiles(dir)).map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  });

  test("an empty directory collects nothing", async () => {
    expect(await collectFiles(dir)).toEqual([]);
  });

  test("skip rules are exposed for the caller to explain itself", () => {
    expect(isSkipped("node_modules")).toBe(true);
    expect(isSkipped("index.html")).toBe(false);
  });
});
