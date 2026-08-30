import { describe, expect, test } from "bun:test";
import { detectProjectType, parseQuaiToml, resolveDeploySpec } from "./manifest";

const files = (...names: string[]) => new Set(names);

describe("type detection", () => {
  test("a lockfile identifies a Bun project", () => {
    expect(detectProjectType(files("bun.lockb", "package.json"))).toMatchObject({
      type: "service",
      runtime: "bun",
    });
  });

  test("the text lockfile is recognised too", () => {
    expect(detectProjectType(files("bun.lock", "package.json"))?.runtime).toBe("bun");
  });

  test("a package.json identifies a Node project", () => {
    expect(detectProjectType(files("package.json"))).toMatchObject({
      type: "service",
      runtime: "node",
    });
  });

  test("requirements.txt identifies a Python project", () => {
    expect(detectProjectType(files("requirements.txt"))?.runtime).toBe("python");
  });

  test("pyproject.toml identifies a Python project", () => {
    expect(detectProjectType(files("pyproject.toml"))?.runtime).toBe("python");
  });

  test("an index.html with no manifest is a static site", () => {
    expect(detectProjectType(files("index.html", "style.css"))).toMatchObject({
      type: "static",
    });
  });

  test("Bun wins over Node, since a Bun project also has a package.json", () => {
    expect(detectProjectType(files("bun.lockb", "package.json"))?.runtime).toBe("bun");
  });

  test("a manifest alongside an index.html is still a service", () => {
    // A framework's public/index.html must not make the whole project static.
    expect(detectProjectType(files("package.json", "index.html"))?.type).toBe("service");
  });

  test("two competing manifests are refused rather than guessed", () => {
    // Node and Python together could be either; guessing would deploy the
    // wrong thing silently.
    expect(() => detectProjectType(files("package.json", "requirements.txt"))).toThrow(
      /ambiguous/i,
    );
  });

  test("a directory with nothing recognisable yields null", () => {
    expect(detectProjectType(files("notes.txt"))).toBeNull();
  });

  test("an empty directory yields null", () => {
    expect(detectProjectType(files())).toBeNull();
  });
});

describe("reading quai.toml", () => {
  test("a minimal manifest gives the type", () => {
    expect(parseQuaiToml('type = "static"')).toMatchObject({ type: "static" });
  });

  test("a service manifest carries its start command and port", () => {
    const manifest = parseQuaiToml(`
      name = "my-api"
      type = "service"
      runtime = "node"

      [service]
      internal_port = 3000
      start = "node server.js"
    `);
    expect(manifest).toMatchObject({
      name: "my-api",
      type: "service",
      runtime: "node",
      service: { internal_port: 3000, start: "node server.js" },
    });
  });

  test("limits are read", () => {
    const manifest = parseQuaiToml(`
      type = "service"
      [limits]
      memory = "512Mi"
      cpu = "1"
      pids = 128
    `);
    expect(manifest.limits).toMatchObject({ memory: "512Mi", cpu: "1", pids: 128 });
  });

  test("environment variables are read", () => {
    const manifest = parseQuaiToml(`
      type = "service"
      [env]
      NODE_ENV = "production"
    `);
    expect(manifest.env).toMatchObject({ NODE_ENV: "production" });
  });

  test("custom domains are read", () => {
    const manifest = parseQuaiToml(`
      type = "static"
      [domains]
      custom = ["api.example.com"]
    `);
    expect(manifest.domains?.custom).toEqual(["api.example.com"]);
  });

  test("comments are ignored", () => {
    expect(parseQuaiToml('# a comment\ntype = "static"').type).toBe("static");
  });

  test("an unknown type is refused", () => {
    expect(() => parseQuaiToml('type = "magic"')).toThrow(/type/i);
  });

  test("a malformed manifest is refused with its reason", () => {
    expect(() => parseQuaiToml("type = ")).toThrow();
  });
});

describe("resolving what to deploy", () => {
  test("the manifest wins over detection", () => {
    const spec = resolveDeploySpec(files("package.json"), 'type = "static"');
    expect(spec.type).toBe("static");
  });

  test("detection applies when no manifest is present", () => {
    expect(resolveDeploySpec(files("index.html"), null).type).toBe("static");
  });

  test("a service detected without a start command is refused", () => {
    // Quai will not invent how to run a project.
    expect(() => resolveDeploySpec(files("package.json"), null)).toThrow(/start/i);
  });

  test("a manifest supplies the start command detection cannot infer", () => {
    const spec = resolveDeploySpec(
      files("package.json"),
      'type = "service"\n[service]\nstart = "node app.js"',
    );
    expect(spec.start).toBe("node app.js");
  });

  test("an unrecognisable directory is refused with an actionable message", () => {
    expect(() => resolveDeploySpec(files("notes.txt"), null)).toThrow(/quai\.toml/i);
  });

  test("a plain static directory needs no manifest at all", () => {
    // The common case must stay ceremony-free.
    expect(() => resolveDeploySpec(files("index.html"), null)).not.toThrow();
  });

  test("the declared port reaches the deploy spec", () => {
    const spec = resolveDeploySpec(
      files("package.json"),
      'type = "service"\n[service]\nstart = "node app.js"\ninternal_port = 3000',
    );
    expect(spec.internalPort).toBe(3000);
  });
});


describe("a lone handler file", () => {
  test("api.js alone is a Node function", () => {
    // The spec's second story: deploy a single file with no configuration.
    expect(detectProjectType(new Set(["api.js"]))).toMatchObject({
      type: "function",
      runtime: "node",
    });
  });

  test("api.py alone is a Python function", () => {
    expect(detectProjectType(new Set(["api.py"]))?.runtime).toBe("python");
  });

  test("api.ts alone is a Bun function", () => {
    expect(detectProjectType(new Set(["api.ts"]))?.runtime).toBe("bun");
  });

  test("the handler needs no start command in a manifest", () => {
    const spec = resolveDeploySpec(new Set(["api.js"]), null);
    expect(spec.type).toBe("function");
    expect(spec.start).toBe("api.js");
  });

  test("a package.json wins, since the handler is then part of a larger project", () => {
    expect(detectProjectType(new Set(["api.js", "package.json"]))?.type).toBe("service");
  });

  test("an index.html wins, since a site may well contain an api.js", () => {
    expect(detectProjectType(new Set(["api.js", "index.html"]))?.type).toBe("static");
  });
});

