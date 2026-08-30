import { describe, expect, test } from "bun:test";
import { projectNameFromPath, subdomainOf } from "./naming";

describe("project naming", () => {
  test("the name comes from the directory, so it is stable across deploys", () => {
    expect(projectNameFromPath("/home/arthur/code/my-site")).toBe("my-site");
  });

  test("a trailing slash does not change the name", () => {
    expect(projectNameFromPath("/home/arthur/code/my-site/")).toBe("my-site");
  });

  test("the same directory always yields the same name", () => {
    // Redeploying must update the existing project rather than create a twin.
    const first = projectNameFromPath("/home/arthur/code/my-site");
    const second = projectNameFromPath("/home/arthur/code/my-site/");
    expect(first).toBe(second);
  });

  test("uppercase is folded, because hostnames are case-insensitive", () => {
    expect(projectNameFromPath("/code/MySite")).toBe("mysite");
  });

  test("spaces and underscores become hyphens", () => {
    expect(projectNameFromPath("/code/my cool_site")).toBe("my-cool-site");
  });

  test("characters illegal in a hostname become separators, not deletions", () => {
    // Dropping them would silently merge words: "my.site" must not become
    // "mysite", because that reads as a different project.
    expect(projectNameFromPath("/code/my.site!@#")).toBe("my-site");
  });

  test("leading and trailing hyphens are trimmed, as hostnames forbid them", () => {
    expect(projectNameFromPath("/code/--edge--")).toBe("edge");
  });

  test("runs of separators collapse into a single hyphen", () => {
    expect(projectNameFromPath("/code/a___b   c")).toBe("a-b-c");
  });

  test("a name is truncated to the DNS label limit", () => {
    const long = "x".repeat(100);
    expect(projectNameFromPath("/code/" + long).length).toBe(63);
  });

  test("truncation never leaves a trailing hyphen", () => {
    const name = projectNameFromPath("/code/" + "ab-".repeat(40));
    expect(name.endsWith("-")).toBe(false);
  });

  test("a directory with no usable characters is rejected", () => {
    expect(() => projectNameFromPath("/code/!!!")).toThrow(/name/i);
  });

  test("the filesystem root is rejected rather than silently named", () => {
    expect(() => projectNameFromPath("/")).toThrow();
  });
});

describe("subdomain routing", () => {
  test("a project is served under the wildcard zone", () => {
    expect(subdomainOf("my-site", "quai.example.com")).toBe("my-site.quai.example.com");
  });

  test("the host header is matched back to its project", () => {
    const { projectFor } = require("./naming");
    expect(projectFor("my-site.quai.example.com", "quai.example.com")).toBe("my-site");
  });

  test("a port in the host header is ignored", () => {
    const { projectFor } = require("./naming");
    expect(projectFor("my-site.quai.example.com:8080", "quai.example.com")).toBe("my-site");
  });

  test("the host header is matched case-insensitively", () => {
    const { projectFor } = require("./naming");
    expect(projectFor("My-Site.Quai.Example.Com", "quai.example.com")).toBe("my-site");
  });

  test("a host outside the zone belongs to no project", () => {
    const { projectFor } = require("./naming");
    expect(projectFor("elsewhere.example.com", "quai.example.com")).toBeNull();
  });

  test("the bare zone itself is not a project", () => {
    const { projectFor } = require("./naming");
    expect(projectFor("quai.example.com", "quai.example.com")).toBeNull();
  });

  test("a nested subdomain is not treated as a project", () => {
    // "a.b.quai.example.com" must not resolve to the project "a.b".
    const { projectFor } = require("./naming");
    expect(projectFor("a.b.quai.example.com", "quai.example.com")).toBeNull();
  });

  test("a zone suffix that merely ends the same is not a match", () => {
    // "evilquai.example.com" ends with "quai.example.com" as a string.
    const { projectFor } = require("./naming");
    expect(projectFor("site.evilquai.example.com", "quai.example.com")).toBeNull();
  });
});

