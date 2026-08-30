import { describe, expect, test } from "bun:test";
import { deployQuery } from "./deploy-query";

describe("what the client tells the server", () => {
  test("the type is always sent", () => {
    expect(deployQuery({ type: "static" }).get("type")).toBe("static");
  });

  test("a declared memory limit reaches the server", () => {
    // Otherwise a project asking for 512Mi silently runs on the default.
    const query = deployQuery({ type: "service", start: "node s.js", limits: { memory: "512Mi" } });
    expect(query.get("memory")).toBe("512Mi");
  });

  test("cpu, pids and disk limits reach the server", () => {
    const query = deployQuery({
      type: "service",
      start: "node s.js",
      limits: { cpu: "2", pids: 128, disk: "5Gi" },
    });
    expect(query.get("cpu")).toBe("2");
    expect(query.get("pids")).toBe("128");
    expect(query.get("disk")).toBe("5Gi");
  });

  test("an absent limit is not sent, so the default applies", () => {
    expect(deployQuery({ type: "static" }).has("memory")).toBe(false);
  });

  test("a declared timeout reaches the server", () => {
    const query = deployQuery({ type: "function", start: "api.js", timeoutSeconds: 45 });
    expect(query.get("timeout")).toBe("45");
  });

  test("environment variables are sent as JSON", () => {
    const query = deployQuery({ type: "static", env: { NODE_ENV: "production" } });
    expect(JSON.parse(query.get("env")!)).toEqual({ NODE_ENV: "production" });
  });

  test("a value with special characters survives the encoding", () => {
    const query = deployQuery({ type: "static", env: { DSN: "postgres://u:p@h/db?x=1&y=2" } });
    expect(JSON.parse(query.get("env")!).DSN).toBe("postgres://u:p@h/db?x=1&y=2");
  });

  test("domains are always sent, so removing one takes effect", () => {
    // An omitted parameter would leave a retired domain still serving.
    expect(deployQuery({ type: "static" }).get("domains")).toBe("");
  });

  test("production is flagged when asked for", () => {
    expect(deployQuery({ type: "static" }, { production: true }).get("prod")).toBe("1");
  });

  test("an ordinary deploy carries no production flag", () => {
    expect(deployQuery({ type: "static" }).has("prod")).toBe(false);
  });
});

