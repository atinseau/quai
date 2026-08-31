import { describe, expect, test } from "bun:test";
import { renderQuaiToml } from "./init";

describe("generating a quai.toml", () => {
  test("a static project needs only its type", () => {
    const rendered = renderQuaiToml({ name: "my-site", type: "static" });
    expect(rendered).toContain('type = "static"');
    expect(rendered).not.toContain("[service]");
  });

  test("a service carries its start command and port", () => {
    const rendered = renderQuaiToml({
      name: "api",
      type: "service",
      runtime: "node",
      start: "node server.js",
      internalPort: 3000,
    });
    expect(rendered).toContain('start = "node server.js"');
    expect(rendered).toContain("internal_port = 3000");
  });

  test("the generated file parses back to what was asked for", () => {
    // A generator that emits something its own parser rejects is worse than
    // no generator at all.
    const { parseQuaiToml } = require("./manifest");
    const rendered = renderQuaiToml({
      name: "api",
      type: "service",
      runtime: "bun",
      start: "bun run index.ts",
      internalPort: 8080,
    });
    expect(parseQuaiToml(rendered)).toMatchObject({
      name: "api",
      type: "service",
      runtime: "bun",
      service: { start: "bun run index.ts", internal_port: 8080 },
    });
  });

  test("a build command is included when given", () => {
    const rendered = renderQuaiToml({
      name: "site",
      type: "static",
      build: { command: "npm run build", output: "dist" },
    });
    expect(rendered).toContain('command = "npm run build"');
    expect(rendered).toContain('output = "dist"');
  });

  test("the file is commented, so it can be edited without the docs", () => {
    expect(renderQuaiToml({ name: "s", type: "static" })).toContain("#");
  });

  test("a name with a quote cannot break the file", () => {
    const rendered = renderQuaiToml({ name: 'we"ird', type: "static" });
    const { parseQuaiToml } = require("./manifest");
    expect(() => parseQuaiToml(rendered)).not.toThrow();
  });
});

describe("what init generates is always accepted", () => {
  const { parseQuaiToml } = require("./manifest");

  test("a directory name with a quote produces a valid manifest", () => {
    // The generator must not emit a file its own parser refuses.
    expect(() => parseQuaiToml(renderQuaiToml({ name: 'we"ird', type: "static" }))).not.toThrow();
  });

  test("an uppercase directory name is folded", () => {
    const rendered = renderQuaiToml({ name: "MySite", type: "static" });
    expect(rendered).toContain('name = "mysite"');
  });

  test("a directory name with spaces becomes hyphens", () => {
    expect(renderQuaiToml({ name: "my cool site", type: "static" })).toContain(
      'name = "my-cool-site"',
    );
  });

  test("a name with nothing usable falls back rather than emitting an empty one", () => {
    expect(() => parseQuaiToml(renderQuaiToml({ name: "!!!", type: "static" }))).not.toThrow();
  });

  test("a generated service manifest validates", () => {
    expect(() =>
      parseQuaiToml(
        renderQuaiToml({
          name: "api",
          type: "service",
          runtime: "node",
          start: "node server.js",
          internalPort: 3000,
        }),
      ),
    ).not.toThrow();
  });
});
