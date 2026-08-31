import { describe, expect, test } from "bun:test";
import { LinuxRunner } from "./linux-runner";
import { NetworkNamespace, allocateSubnet } from "./netns";
import type { RunSpec } from "./runner";

/** Exposes the argv so the launch contract can be checked without a container. */
class Inspectable extends LinuxRunner {
  argvFor(spec: RunSpec, namespace: NetworkNamespace | null = null): string[] {
    return this.buildArgv(spec, namespace);
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
const namespace = new NetworkNamespace("api", allocateSubnet(0), 3000);

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
    expect(argv.slice(argv.indexOf("env"))).toContain("HOME=/home/quai-api");
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

describe("launching inside a namespace", () => {
  test("the process is placed in the project's namespace", () => {
    expect(runner.argvFor(spec, namespace).slice(0, 4)).toEqual([
      "ip",
      "netns",
      "exec",
      "quai-api",
    ]);
  });

  test("the namespace is entered before privileges are dropped", () => {
    // Entering needs NET_ADMIN, which the project itself must never hold.
    const argv = runner.argvFor(spec, namespace);
    expect(argv.indexOf("netns")).toBeLessThan(argv.indexOf("setpriv"));
  });

  test("the command still ends the line inside a namespace", () => {
    expect(runner.argvFor(spec, namespace).slice(-2)).toEqual(["node", "server.js"]);
  });

  test("two projects listening on the same port get different addresses", () => {
    // Same port, different namespace: no collision to resolve.
    const alpha = new NetworkNamespace("alpha", allocateSubnet(0), 8080);
    const beta = new NetworkNamespace("beta", allocateSubnet(1), 8080);
    expect(alpha.subnet.projectAddress).not.toBe(beta.subnet.projectAddress);
    expect(alpha.internalPort).toBe(beta.internalPort);
  });
});
