import { describe, expect, test } from "bun:test";
import { NetworkNamespace, allocateSubnet, namespaceNameFor } from "./netns";

describe("namespace naming", () => {
  test("a project maps to its own namespace", () => {
    expect(namespaceNameFor("api")).toBe("quai-api");
  });

  test("two projects never share a namespace", () => {
    expect(namespaceNameFor("alpha")).not.toBe(namespaceNameFor("beta"));
  });
});

describe("subnet allocation", () => {
  test("each project gets a distinct point-to-point subnet", () => {
    const a = allocateSubnet(0);
    const b = allocateSubnet(1);
    expect(a.projectAddress).not.toBe(b.projectAddress);
  });

  test("the host and project ends sit in the same subnet", () => {
    const subnet = allocateSubnet(0);
    expect(subnet.hostAddress.split(".").slice(0, 3)).toEqual(
      subnet.projectAddress.split(".").slice(0, 3),
    );
  });

  test("addresses come from the private range", () => {
    expect(allocateSubnet(0).projectAddress.startsWith("10.")).toBe(true);
  });

  test("allocation is deterministic, so a restart rebuilds the same wiring", () => {
    expect(allocateSubnet(7)).toEqual(allocateSubnet(7));
  });

  test("the index maps into distinct /30 subnets", () => {
    // A /30 gives exactly two usable addresses: one per end of the veth pair.
    const first = allocateSubnet(0);
    const second = allocateSubnet(1);
    expect(first.hostAddress).not.toBe(second.hostAddress);
    expect(first.prefixLength).toBe(30);
  });

  test("a large index still yields a valid address", () => {
    const subnet = allocateSubnet(500);
    for (const octet of subnet.projectAddress.split(".")) {
      expect(Number(octet)).toBeLessThanOrEqual(255);
    }
  });
});

describe("namespace commands", () => {
  const ns = new NetworkNamespace("api", allocateSubnet(0), 8080);

  test("creating a namespace uses the project's own name", () => {
    expect(ns.createCommands()[0]).toEqual(["ip", "netns", "add", "quai-api"]);
  });

  test("a veth pair links the namespace to the host", () => {
    const commands = ns.createCommands().map((c) => c.join(" "));
    expect(commands.some((c) => c.includes("veth"))).toBe(true);
  });

  test("loopback is brought up, so a service may bind 127.0.0.1", () => {
    const commands = ns.createCommands().map((c) => c.join(" "));
    expect(commands.some((c) => c.includes("lo") && c.includes("up"))).toBe(true);
  });

  test("the project end is addressed inside the namespace", () => {
    const commands = ns.createCommands().map((c) => c.join(" "));
    expect(commands.some((c) => c.includes(ns.subnet.projectAddress))).toBe(true);
  });

  test("teardown removes the namespace, so nothing leaks between deploys", () => {
    expect(ns.destroyCommands()).toContainEqual(["ip", "netns", "del", "quai-api"]);
  });

  test("a process is launched inside the namespace", () => {
    expect(ns.wrapCommand(["node", "server.js"]).slice(0, 4)).toEqual([
      "ip",
      "netns",
      "exec",
      "quai-api",
    ]);
  });

  test("the wrapped command keeps its own arguments last", () => {
    expect(ns.wrapCommand(["node", "server.js"]).slice(-2)).toEqual(["node", "server.js"]);
  });
});
