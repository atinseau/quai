import { describe, expect, test } from "bun:test";
import { handleRequest, type RouterContext } from "./router";

const ZONE = "quai.example.com";

function contextWith(sites: Record<string, Record<string, string>>): RouterContext {
  return {
    zone: ZONE,
    health: { status: "healthy", isolation: { supported: true, failing: [] }, runtimes: [] },
    lookup: (project) => (sites[project] ? { name: project, type: "static" } : null),
    readFile: async (root, path) => {
      const project = root.split("/").pop() ?? "";
      return sites[project]?.[path] ?? null;
    },
    rootFor: (project) => "/srv/quai/sites/" + project,
    proxy: async () => new Response("not a service", { status: 500 }),
  };
}

const context = contextWith({
  "my-site": { "/srv/quai/sites/my-site/index.html": "<h1>hello</h1>" },
});

async function get(url: string, host: string, ctx: RouterContext = context) {
  return handleRequest(new Request(url, { headers: { host } }), ctx);
}

describe("router", () => {
  test("a deployed project serves its index at the root", async () => {
    const response = await get("http://x/", "my-site." + ZONE);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>hello</h1>");
  });

  test("an unknown project answers 404", async () => {
    const response = await get("http://x/", "nope." + ZONE);
    expect(response.status).toBe(404);
  });

  test("a missing file inside a known project answers 404", async () => {
    const response = await get("http://x/absent.css", "my-site." + ZONE);
    expect(response.status).toBe(404);
  });

  test("a traversal attempt answers 404 rather than serving the file", async () => {
    const response = await get("http://x/../../etc/passwd", "my-site." + ZONE);
    expect(response.status).toBe(404);
  });

  test("a host outside the zone answers 404", async () => {
    const response = await get("http://x/", "elsewhere.example.com");
    expect(response.status).toBe(404);
  });

  test("a request with no host header answers 404", async () => {
    const response = await handleRequest(new Request("http://x/"), context);
    expect(response.status).toBe(404);
  });

  test("the health endpoint answers on the bare zone, not through a project", async () => {
    const response = await get("http://x/health", ZONE);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "healthy" });
  });

  test("health reports 503 when isolation is broken", async () => {
    const broken = { ...context, health: { ...context.health, status: "unhealthy" as const } };
    const response = await get("http://x/health", ZONE, broken);
    expect(response.status).toBe(503);
  });

  test("a project named health does not shadow the health endpoint", async () => {
    // The endpoint lives on the bare zone, so a project can still be called
    // "health" without hijacking it.
    const ctx = contextWith({ health: { "/srv/quai/sites/health/index.html": "mine" } });
    const response = await get("http://x/", "health." + ZONE, ctx);
    expect(await response.text()).toBe("mine");
  });

  test("content type is inferred from the file extension", async () => {
    const ctx = contextWith({ "my-site": { "/srv/quai/sites/my-site/app.css": "body{}" } });
    const response = await get("http://x/app.css", "my-site." + ZONE, ctx);
    expect(response.headers.get("content-type")).toContain("text/css");
  });
});

