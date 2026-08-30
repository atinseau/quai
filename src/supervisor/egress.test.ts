import { describe, expect, test } from "bun:test";
import { EgressPolicy, PRIVATE_RANGES, natCommands, natInstallCommand } from "./egress";
import { allocateSubnet } from "./netns";

const policy = new EgressPolicy("quai-api", allocateSubnet(0), "qh-api");

describe("egress rules", () => {
  test("the project may reach the public internet", () => {
    const rules = policy.rules().map((r) => r.join(" "));
    expect(rules.some((r) => r.includes("ACCEPT"))).toBe(true);
  });

  test("every private range is blocked", () => {
    const rules = policy.rules().map((r) => r.join(" "));
    for (const range of PRIVATE_RANGES) {
      expect(rules.some((r) => r.includes(range) && r.includes("REJECT"))).toBe(true);
    }
  });

  test("the supervisor's own veth end stays reachable", () => {
    // The router proxies requests over this link; blocking it would cut the
    // project off from the outside world entirely.
    const rules = policy.rules().map((r) => r.join(" "));
    const acceptsHost = rules.some(
      (r) => r.includes(policy.subnet.hostAddress) && r.includes("ACCEPT"),
    );
    expect(acceptsHost).toBe(true);
  });

  test("the host exception is ordered before the private-range blocks", () => {
    // iptables takes the first match, so a later ACCEPT would never be read.
    const rules = policy.rules().map((r) => r.join(" "));
    const hostIndex = rules.findIndex((r) => r.includes(policy.subnet.hostAddress));
    const blockIndex = rules.findIndex((r) => r.includes("10.0.0.0/8"));
    expect(hostIndex).toBeLessThan(blockIndex);
  });

  test("the Quai veth range is blocked, so neighbours are unreachable", () => {
    // The gap left open by the network namespaces: a project could still reach
    // a neighbour by aiming at its veth address.
    const rules = policy.rules().map((r) => r.join(" "));
    expect(rules.some((r) => r.includes("10.83.0.0/16") && r.includes("REJECT"))).toBe(true);
  });

  test("rules are applied inside the project's namespace", () => {
    expect(policy.rules()[0]!.slice(0, 4)).toEqual(["ip", "netns", "exec", "quai-api"]);
  });

  test("rules live in the OUTPUT chain, so they govern what the project sends", () => {
    const rules = policy.rules().map((r) => r.join(" "));
    expect(rules.every((r) => r.includes("OUTPUT"))).toBe(true);
  });

  test("DNS resolution is still possible", () => {
    // Blocking every private range would break resolvers on the host network.
    const rules = policy.rules().map((r) => r.join(" "));
    expect(rules.some((r) => r.includes("53"))).toBe(true);
  });

  test("loopback inside the namespace is untouched", () => {
    // A project's own components may talk to each other over 127.0.0.1.
    const rules = policy.rules().map((r) => r.join(" "));
    expect(rules.some((r) => r.includes("127.0.0.0/8") && r.includes("ACCEPT"))).toBe(true);
  });
});


describe("internet access", () => {
  test("masquerading is installed for the Quai veth range", () => {
    // Without NAT a project's packets leave with a 10.83 source address that
    // nothing on the internet can answer: the route exists but replies vanish.
    const rule = natInstallCommand().join(" ");
    expect(rule).toContain("MASQUERADE");
    expect(rule).toContain("10.83.0.0/16");
  });

  test("masquerading applies to the nat table's POSTROUTING chain", () => {
    const rule = natInstallCommand().join(" ");
    expect(rule).toContain("nat");
    expect(rule).toContain("POSTROUTING");
  });

  test("traffic between projects is excluded from masquerading", () => {
    // Rewriting the source on a veth-to-veth packet would defeat the OUTPUT
    // rules that keep neighbours apart.
    expect(natInstallCommand().join(" ")).toContain("! -o qh-+");
  });

  test("forwarding is enabled, or nothing leaves the namespace at all", () => {
    const commands = natCommands().map((c) => c.join(" "));
    expect(commands.some((c) => c.includes("ip_forward=1"))).toBe(true);
  });

  test("installation is checked before being applied, so restarts do not stack rules", () => {
    // -C tests for an existing rule; without it every restart would append a
    // duplicate.
    expect(natCommands().some((c) => c.includes("-C"))).toBe(true);
  });
});

