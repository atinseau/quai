import { describe, expect, test } from "bun:test";
import { handleRequest, type RouterContext } from "./router";

const ZONE = "quai.example.com";

function context(overrides: Partial<RouterContext> = {}): RouterContext {
  return {
    zone: ZONE,
    health: { status: "healthy", isolation: { supported: true, failing: [] }, runtimes: [] },
    lookup: () => null,
    readFile: async () => null,
    rootFor: (p) => "/srv/quai/sites/" + p,
    proxy: async () => new Response("proxied"),
    ...overrides,
  };
}

const get = (host: string, ctx: RouterContext, path = "/") =>
  handleRequest(new Request("http://x" + path, { headers: { host } }), ctx);

describe("custom domains", () => {
  test("a custom domain serves its project", async () => {
    const ctx = context({
      projectForDomain: (domain) => (domain === "www.example.com" ? "site" : null),
      lookup: () => ({ name: "site", type: "static" }),
      readFile: async () => "<h1>hi</h1>",
    });
    const response = await get("www.example.com", ctx);
    expect(await response.text()).toBe("<h1>hi</h1>");
  });

  test("the subdomain keeps working alongside the custom domain", async () => {
    const ctx = context({
      projectForDomain: () => null,
      lookup: () => ({ name: "site", type: "static" }),
      readFile: async () => "<h1>hi</h1>",
    });
    expect((await get("site." + ZONE, ctx)).status).toBe(200);
  });

  test("an unclaimed domain answers 404", async () => {
    const ctx = context({ projectForDomain: () => null });
    expect((await get("nobody.example.com", ctx)).status).toBe(404);
  });

  test("a custom domain is matched case-insensitively", async () => {
    const seen: string[] = [];
    const ctx = context({
      projectForDomain: (domain) => {
        seen.push(domain);
        return null;
      },
    });
    await get("WWW.Example.COM", ctx);
    expect(seen).toContain("www.example.com");
  });

  test("a port in the host header does not defeat the lookup", async () => {
    const seen: string[] = [];
    const ctx = context({
      projectForDomain: (domain) => {
        seen.push(domain);
        return null;
      },
    });
    await get("www.example.com:8080", ctx);
    expect(seen).toContain("www.example.com");
  });

  test("a custom domain reaches a service through the proxy", async () => {
    const ctx = context({
      projectForDomain: () => "api",
      lookup: () => ({ name: "api", type: "service", internalPort: 3000 }),
      proxy: async () => new Response("from the service"),
    });
    expect(await (await get("api.example.com", ctx)).text()).toBe("from the service");
  });

  test("the zone itself is never treated as a custom domain", async () => {
    // Otherwise a project could claim the zone and shadow every subdomain.
    const ctx = context({ projectForDomain: () => "greedy" });
    expect((await get(ZONE, ctx, "/health")).status).toBe(200);
  });
});

