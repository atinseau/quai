import { describe, expect, test } from "bun:test";
import { resolveStaticFile } from "./static";

const ROOT = "/srv/quai/sites/my-site";

describe("static file resolution", () => {
  test("the root path serves the index", () => {
    expect(resolveStaticFile(ROOT, "/")).toBe(ROOT + "/index.html");
  });

  test("a file is served from its path", () => {
    expect(resolveStaticFile(ROOT, "/style.css")).toBe(ROOT + "/style.css");
  });

  test("a nested file keeps its path", () => {
    expect(resolveStaticFile(ROOT, "/assets/app.js")).toBe(ROOT + "/assets/app.js");
  });

  test("a directory path serves its index", () => {
    expect(resolveStaticFile(ROOT, "/docs/")).toBe(ROOT + "/docs/index.html");
  });

  test("a query string does not become part of the path", () => {
    expect(resolveStaticFile(ROOT, "/app.js?v=2")).toBe(ROOT + "/app.js");
  });

  test("percent-encoded characters are decoded", () => {
    expect(resolveStaticFile(ROOT, "/my%20file.txt")).toBe(ROOT + "/my file.txt");
  });

  test("a traversal is rejected rather than served", () => {
    expect(resolveStaticFile(ROOT, "/../../etc/passwd")).toBeNull();
  });

  test("a percent-encoded traversal is rejected too", () => {
    // Decoding before the check is what makes %2e%2e dangerous.
    expect(resolveStaticFile(ROOT, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });

  test("a backslash traversal is rejected", () => {
    expect(resolveStaticFile(ROOT, "/..\\..\\etc/passwd")).toBeNull();
  });

  test("a malformed percent-encoding is rejected rather than throwing", () => {
    expect(resolveStaticFile(ROOT, "/%")).toBeNull();
  });

  test("a null byte in the path is rejected", () => {
    expect(resolveStaticFile(ROOT, "/index.html\u0000.txt")).toBeNull();
  });
});
