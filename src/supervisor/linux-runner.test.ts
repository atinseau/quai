import { describe, expect, test } from "bun:test";
import { LinuxRunner } from "./linux-runner";
import type { RunSpec } from "./runner";

/** Exposes the argv so the launch contract can be checked without a container. */
class Inspectable extends LinuxRunner {
  argvFor(spec: RunSpec): string[] {
    return this.buildArgv(spec);
  }
}

const spec: RunSpec = {
  project: "api",
  uid: 10007,
  home: "/home/quai-api",
  command: ["node", "server.js"],
  internalPort: 3000,
  env: { NODE_ENV: "production" },
};

const runner = new Inspectable();

describe("launch contract", () => {
  test("the process is dropped to the project's uid before exec", () => {
    const argv = runner.argvFor(spec);
    expect(argv.slice(0, 6)).toEqual([
      "setpriv",
      "--reuid",
      "10007",
      "--regid",
      "10007",
      "--clear-groups",
    ]);
  });

  test("supplementary groups are cleared, so no group grants extra access", () => {
    expect(runner.argvFor(spec)).toContain("--clear-groups");
  });

  test("HOME is applied after the uid switch, since setpriv resets it", () => {
    // Without this the process runs with root's HOME and cannot write its own
    // files — the exact failure seen in the container.
    const argv = runner.argvFor(spec);
    const envIndex = argv.indexOf("env");
    expect(argv.slice(envIndex)).toContain("HOME=/home/quai-api");
  });

  test("PORT tells the process where to listen", () => {
    expect(runner.argvFor(spec)).toContain("PORT=3000");
  });

  test("the project's own variables are passed through", () => {
    expect(runner.argvFor(spec)).toContain("NODE_ENV=production");
  });

  test("the command is the last thing on the line, so nothing shadows it", () => {
    expect(runner.argvFor(spec).slice(-2)).toEqual(["node", "server.js"]);
  });

  test("a project variable cannot override the uid switch", () => {
    // Environment entries come after "env", so they can never be read as
    // setpriv arguments.
    const argv = runner.argvFor({ ...spec, env: { "--reuid": "0" } });
    expect(argv.indexOf("--reuid")).toBeLessThan(argv.indexOf("env"));
  });

  test("running as root is refused outright", async () => {
    await expect(runner.start({ ...spec, uid: 0 })).rejects.toThrow(/root/i);
  });
});

