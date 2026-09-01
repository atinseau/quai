import { describe, expect, test } from "bun:test";
import { contentTypeFor, resolveStaticFile } from "./static";

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

describe("how a file is served", () => {
  test("a page is served as html, so a browser renders it", () => {
    expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8");
  });

  test("a stylesheet and a script get the types a browser requires", () => {
    // A browser refuses a stylesheet or a module served as anything else.
    expect(contentTypeFor("/app.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/app.js")).toBe("text/javascript; charset=utf-8");
  });

  test("text formats declare utf-8, so accents survive the trip", () => {
    expect(contentTypeFor("/data.json")).toContain("charset=utf-8");
    expect(contentTypeFor("/notes.txt")).toContain("charset=utf-8");
  });

  test("a font is typed, so a browser does not refuse to load it", () => {
    expect(contentTypeFor("/inter.woff2")).toBe("font/woff2");
  });

  test("the extension is read regardless of case", () => {
    expect(contentTypeFor("/PHOTO.PNG")).toBe("image/png");
  });

  test("only the last extension counts", () => {
    expect(contentTypeFor("/archive.tar.gz")).toBe("application/octet-stream");
    expect(contentTypeFor("/app.min.js")).toBe("text/javascript; charset=utf-8");
  });

  test("an unknown extension is an opaque download rather than a guess", () => {
    expect(contentTypeFor("/report.xyz")).toBe("application/octet-stream");
  });

  test("a file with no extension is not mistaken for one", () => {
    expect(contentTypeFor("/LICENSE")).toBe("application/octet-stream");
  });
});
