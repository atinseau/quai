import { describe, expect, test } from "bun:test";
import { defineConfig, defineHandler, defineBunHandler } from "./index";

describe("typing a Node handler", () => {
  test("the handler is returned unchanged, so nothing is wrapped at runtime", () => {
    // defineHandler exists for the type checker and the editor; adding runtime
    // behaviour would make the deployed code differ from what was written.
    const handler = (_request: unknown, response: { end(body: string): void }) =>
      response.end("hi");
    expect(defineHandler(handler)).toBe(handler);
  });

  test("an async handler is accepted", () => {
    const handler = async () => {};
    expect(defineHandler(handler)).toBe(handler);
  });
});

describe("typing a Bun handler", () => {
  test("the handler is returned unchanged", () => {
    const handler = (_request: Request) => new Response("hi");
    expect(defineBunHandler(handler)).toBe(handler);
  });
});

describe("typing a manifest", () => {
  test("a minimal config is returned unchanged", () => {
    const config = { type: "static" as const };
    expect(defineConfig(config)).toBe(config);
  });

  test("a full service config keeps every field", () => {
    const config = defineConfig({
      name: "api",
      type: "service",
      runtime: "node",
      service: { internalPort: 3000, start: "node server.js" },
      limits: { memory: "512Mi", cpu: "1", pids: 128, disk: "2Gi" },
      domains: { custom: ["api.example.com"] },
      env: { NODE_ENV: "production" },
    });
    expect(config.service?.internalPort).toBe(3000);
    expect(config.limits?.memory).toBe("512Mi");
  });

  test("a function config carries its timeout", () => {
    const config = defineConfig({
      type: "function",
      runtime: "python",
      limits: { timeout: "45s" },
    });
    expect(config.limits?.timeout).toBe("45s");
  });
});

describe("the package stands alone", () => {
  test("no Node types are required to use it", async () => {
    // Importing node:http would force @types/node on every user, including
    // projects that only deploy a static site or a Bun function.
    //
    // Read from the source rather than the build output: dist/ is generated
    // and absent from a fresh checkout, so asserting against it passed locally
    // and failed in CI.
    const source = await Bun.file(new URL("./index.ts", import.meta.url).pathname).text();

    // The comment explaining why may name them; an import must not.
    const imports = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line))
      .join("\n");
    expect(imports).toBe("");
  });

  test("a real Node handler still satisfies the type", () => {
    // The structural shape has to accept what the runtime actually passes.
    const handler = defineHandler((request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain");
      response.end(request.url ?? "/");
    });
    expect(typeof handler).toBe("function");
  });
});
