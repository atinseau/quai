import { describe, expect, test } from "bun:test";
import { parseForcedCommand } from "./parse-command";

describe("forced command parsing", () => {
  test("a deploy request yields the project name", () => {
    expect(parseForcedCommand("quai-deploy my-site")).toEqual({ project: "my-site" });
  });

  test("extra whitespace is tolerated", () => {
    expect(parseForcedCommand("  quai-deploy   my-site  ")).toEqual({ project: "my-site" });
  });

  test("a request for a shell is refused", () => {
    // The whole point of the forced command: whatever the client asks for,
    // only a deploy can happen.
    expect(() => parseForcedCommand("/bin/bash")).toThrow(/shell/i);
  });

  test("an empty command is refused", () => {
    expect(() => parseForcedCommand("")).toThrow(/shell/i);
  });

  test("a command smuggled after the deploy verb is refused outright", () => {
    // Refusing beats silently truncating: the client asked for something we
    // will not do, so it should hear about it rather than get a partial deploy.
    expect(() => parseForcedCommand("quai-deploy my-site; rm -rf /")).toThrow(/invalid/i);
  });

  test("a project name with a shell metacharacter is refused", () => {
    expect(() => parseForcedCommand("quai-deploy my-site;evil")).toThrow(/invalid/i);
  });

  test("a project name with a slash is refused, so no path can be targeted", () => {
    expect(() => parseForcedCommand("quai-deploy ../etc")).toThrow(/invalid/i);
  });

  test("an uppercase project name is refused, since names are normalised client-side", () => {
    expect(() => parseForcedCommand("quai-deploy MySite")).toThrow(/invalid/i);
  });

  test("a missing project name is refused", () => {
    expect(() => parseForcedCommand("quai-deploy")).toThrow(/invalid/i);
  });
});

