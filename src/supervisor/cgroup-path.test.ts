import { describe, expect, test } from "bun:test";
import { containerRootOf, parseOwnCgroup } from "./cgroup-path";

describe("reading the container cgroup", () => {
  test("a v2 line gives the path", () => {
    expect(parseOwnCgroup("0::/docker/abc123")).toBe("/docker/abc123");
  });

  test("the v2 line is chosen out of a hybrid file", () => {
    expect(parseOwnCgroup("0::/docker/abc\n1:name=systemd:/other")).toBe("/docker/abc");
  });

  test("a bare root is reported as the root", () => {
    expect(parseOwnCgroup("0::/")).toBe("/");
  });

  test("an unreadable file yields the root rather than throwing", () => {
    expect(parseOwnCgroup("")).toBe("/");
  });
});

describe("recovering the container root after relocation", () => {
  test("an untouched path is already the root", () => {
    expect(containerRootOf("/docker/abc")).toBe("/docker/abc");
  });

  test("a supervisor leaf is stripped", () => {
    // The preflight moves the supervisor into a leaf; reading afterwards must
    // still resolve to the container root.
    expect(containerRootOf("/docker/abc/quai-supervisor")).toBe("/docker/abc");
  });

  test("repeated relocations are all stripped", () => {
    // The bug seen in the container: preflight and runner each moved the
    // supervisor, nesting projects one level deeper on every read.
    expect(containerRootOf("/docker/abc/quai-supervisor/quai-supervisor")).toBe("/docker/abc");
  });

  test("resolution is idempotent, before or after a move", () => {
    const before = containerRootOf("/docker/abc");
    const after = containerRootOf("/docker/abc/quai-supervisor");
    expect(after).toBe(before);
  });

  test("a path segment merely containing quai is not stripped", () => {
    expect(containerRootOf("/docker/myquai-app")).toBe("/docker/myquai-app");
  });

  test("the root itself survives", () => {
    expect(containerRootOf("/")).toBe("/");
  });
});

