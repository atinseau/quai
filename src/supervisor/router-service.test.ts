import { describe, expect, test } from "bun:test";
import { handleRequest, type RouterContext } from "./router";

const ZONE = "quai.example.com";

function context(overrides: Partial<RouterContext> = {}): RouterContext {
  return {
    zone: ZONE,
    health: { status: "healthy", isolation: { supported: true, failing: [] }, runtimes: [] },
    lookup: () => null,
    readFile: async () => null,
    rootFor: (project) => "/srv/quai/sites/" + project,
    proxy: async () => new Response("proxied", { status: 200 }),
    ...overrides,
  };
}

const get = (host: string, ctx: RouterContext, path = "/") =>
  handleRequest(new Request("http://x" + path, { headers: { host } }), ctx);

describe("routing a service project", () => {
  test("a running service receives the request", async () => {
    const ctx = context({
      lookup: () => ({ name: "api", type: "service", internalPort: 8080 }),
      proxy: async () => new Response("from the service", { status: 200 }),
    });
    const response = await get("api." + ZONE, ctx);
    expect(await response.text()).toBe("from the service");
  });

  test("the request is forwarded to the project's own port", async () => {
    let seenPort = -1;
    const ctx = context({
      lookup: () => ({ name: "api", type: "service", internalPort: 3000 }),
      proxy: async (_request, target) => {
        seenPort = target.port;
        return new Response("ok");
      },
    });
    await get("api." + ZONE, ctx);
    expect(seenPort).toBe(3000);
  });

  test("two services may share the same internal port", async () => {
    // Each lives in its own network namespace, so 8080 is not contested.
    const ports: number[] = [];
    const ctx = context({
      lookup: (project) => ({ name: project, type: "service", internalPort: 8080 }),
      proxy: async (_request, target) => {
        ports.push(target.port);
        return new Response("ok");
      },
    });
    await get("alpha." + ZONE, ctx);
    await get("beta." + ZONE, ctx);
    expect(ports).toEqual([8080, 8080]);
  });

  test("the target names the project, so the proxy can find its namespace", async () => {
    let seen = "";
    const ctx = context({
      lookup: () => ({ name: "api", type: "service", internalPort: 8080 }),
      proxy: async (_request, target) => {
        seen = target.project;
        return new Response("ok");
      },
    });
    await get("api." + ZONE, ctx);
    expect(seen).toBe("api");
  });

  test("a service that is down answers 502 rather than 404", async () => {
    // 404 would say the project does not exist; 502 says it exists but is not
    // answering, which is what an operator needs to know.
    const ctx = context({
      lookup: () => ({ name: "api", type: "service", internalPort: 8080 }),
      proxy: async () => {
        throw new Error("connection refused");
      },
    });
    const response = await get("api." + ZONE, ctx);
    expect(response.status).toBe(502);
  });

  test("a static project never reaches the proxy", async () => {
    let proxied = false;
    const ctx = context({
      lookup: () => ({ name: "site", type: "static" }),
      readFile: async () => "<h1>hi</h1>",
      proxy: async () => {
        proxied = true;
        return new Response("nope");
      },
    });
    await get("site." + ZONE, ctx);
    expect(proxied).toBe(false);
  });

  test("the request path is preserved when proxying", async () => {
    let seenPath = "";
    const ctx = context({
      lookup: () => ({ name: "api", type: "service", internalPort: 8080 }),
      proxy: async (request) => {
        seenPath = new URL(request.url).pathname;
        return new Response("ok");
      },
    });
    await get("api." + ZONE, ctx, "/users/42");
    expect(seenPath).toBe("/users/42");
  });
});

