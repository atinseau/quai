import { describe, expect, test } from "bun:test";
import { parseQuaiToml } from "./manifest";

/** The message a developer actually sees when the manifest is wrong. */
const messageFor = (source: string): string => {
  try {
    parseQuaiToml(source);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe("a valid manifest still parses", () => {
  test("the minimal one", () => {
    expect(parseQuaiToml('type = "static"').type).toBe("static");
  });

  test("a full service manifest keeps every field", () => {
    const manifest = parseQuaiToml(`
      name = "my-api"
      type = "service"
      runtime = "node"

      [build]
      command = "npm run build"
      output = "dist"

      [service]
      internal_port = 3000
      start = "node server.js"

      [limits]
      memory = "512Mi"
      cpu = "1"
      pids = 128
      disk = "2Gi"
      timeout = "45s"

      [domains]
      custom = ["api.example.com"]

      [env]
      NODE_ENV = "production"
    `);
    expect(manifest.service?.internal_port).toBe(3000);
    expect(manifest.limits?.memory).toBe("512Mi");
    expect(manifest.domains?.custom).toEqual(["api.example.com"]);
  });
});

describe("a wrong manifest says which key is wrong", () => {
  test("an unknown project type names the accepted ones", () => {
    const message = messageFor('type = "magic"');
    expect(message).toContain("type");
    expect(message).toMatch(/static.*service.*function/s);
  });

  test("an unknown runtime names the accepted ones", () => {
    const message = messageFor('type = "service"\nruntime = "ruby"');
    expect(message).toContain("runtime");
    expect(message).toMatch(/node.*bun.*python/s);
  });

  test("a misspelled key is named, not silently ignored", () => {
    // Previously anything but 'type' was cast through unchecked, so a typo
    // deployed with the setting quietly missing.
    const message = messageFor('type = "service"\n[limits]\nmemroy = "512Mi"');
    expect(message).toContain("memroy");
  });

  test("a misspelled top-level key is named", () => {
    expect(messageFor('type = "static"\nruntim = "node"')).toContain("runtim");
  });

  test("a number where a size string belongs is named with its path", () => {
    const message = messageFor('type = "service"\n[limits]\nmemory = 512');
    expect(message).toContain("limits.memory");
  });

  test("a malformed size is refused before deploying", () => {
    // parseSize would throw on the server; catching it here saves a round trip.
    const message = messageFor('type = "service"\n[limits]\nmemory = "plenty"');
    expect(message).toContain("limits.memory");
  });

  test("a port outside the valid range is refused", () => {
    const message = messageFor('type = "service"\n[service]\ninternal_port = 99999');
    expect(message).toContain("internal_port");
  });

  test("a project name that could not be a hostname is refused", () => {
    expect(messageFor('name = "My_Site"\ntype = "static"')).toContain("name");
  });

  test("a missing type is reported as missing", () => {
    expect(messageFor('runtime = "node"')).toContain("type");
  });

  test("several mistakes are all reported, not just the first", () => {
    // Fixing them one deploy at a time is the slowest possible loop.
    const message = messageFor('type = "magic"\nruntime = "ruby"');
    expect(message).toContain("type");
    expect(message).toContain("runtime");
  });

  test("invalid TOML is reported as such, with its own message", () => {
    const message = messageFor("type = ");
    expect(message.length).toBeGreaterThan(0);
  });

  test("the message tells the developer where to look", () => {
    expect(messageFor('type = "magic"')).toMatch(/quai\.toml/i);
  });
});
