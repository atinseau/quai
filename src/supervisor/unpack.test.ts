import { describe, expect, test } from "bun:test";
import { safeExtractPath } from "./unpack";

const ROOT = "/srv/quai/sites/my-site";

describe("archive extraction paths", () => {
  test("an ordinary file lands inside the project root", () => {
    expect(safeExtractPath(ROOT, "index.html")).toBe(ROOT + "/index.html");
  });

  test("a nested file keeps its structure", () => {
    expect(safeExtractPath(ROOT, "assets/css/app.css")).toBe(ROOT + "/assets/css/app.css");
  });

  test("a leading ./ is normalised away", () => {
    expect(safeExtractPath(ROOT, "./index.html")).toBe(ROOT + "/index.html");
  });

  test("a path escaping the root is rejected", () => {
    // The classic tar traversal: a deploy must never write outside its project.
    expect(() => safeExtractPath(ROOT, "../../etc/passwd")).toThrow(/escape/i);
  });

  test("a traversal hidden mid-path is rejected", () => {
    expect(() => safeExtractPath(ROOT, "assets/../../../etc/passwd")).toThrow(/escape/i);
  });

  test("an absolute path is rejected", () => {
    expect(() => safeExtractPath(ROOT, "/etc/passwd")).toThrow();
  });

  test("a sibling directory sharing the root's prefix is rejected", () => {
    // "/srv/quai/sites/my-site-evil" starts with the root as a string.
    expect(() => safeExtractPath(ROOT, "../my-site-evil/x")).toThrow(/escape/i);
  });

  test("a traversal that returns inside the root is still allowed", () => {
    expect(safeExtractPath(ROOT, "assets/../index.html")).toBe(ROOT + "/index.html");
  });

  test("an empty entry name is rejected", () => {
    expect(() => safeExtractPath(ROOT, "")).toThrow();
  });
});
