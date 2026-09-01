import { describe, expect, test } from "bun:test";
import { devDirectory, localPort, localRunPlan, localStaticFile } from "./dev";

describe("running a project locally", () => {
  test("a function is served by the same host the server uses", () => {
    // Running it any other way would let a function work locally and fail on
    // deploy, which is the whole reason to have a dev command.
    const plan = localRunPlan(
      { type: "function", runtime: "node", start: "api.js" },
      { root: "/work/app", port: 3000 },
    );
    expect(plan.command.join(" ")).toContain("node-host");
    expect(plan.env.QUAI_HANDLER).toBe("api.js");
  });

  test("each runtime uses its own host", () => {
    const bun = localRunPlan(
      { type: "function", runtime: "bun", start: "api.ts" },
      { root: "/work/app", port: 3000 },
    );
    expect(bun.command.join(" ")).toContain("bun-host");
  });

  test("a service is started with its own command", () => {
    const plan = localRunPlan(
      { type: "service", start: "node server.js" },
      { root: "/work/app", port: 3000 },
    );
    expect(plan.command).toEqual(["node", "server.js"]);
  });

  test("PORT is set, so the project listens where the developer is looking", () => {
    const plan = localRunPlan(
      { type: "service", start: "node server.js" },
      { root: "/work/app", port: 4321 },
    );
    expect(plan.env.PORT).toBe("4321");
  });

  test("the declared internal port is ignored locally", () => {
    // On the server each project has its own namespace; on a laptop they share
    // one, so the developer chooses the port.
    const plan = localRunPlan(
      { type: "service", start: "node server.js", internalPort: 8080 },
      { root: "/work/app", port: 4321 },
    );
    expect(plan.env.PORT).toBe("4321");
  });

  test("the project's declared variables are passed through", () => {
    const plan = localRunPlan(
      { type: "service", start: "node server.js", env: { NODE_ENV: "production" } },
      { root: "/work/app", port: 3000 },
    );
    expect(plan.env.NODE_ENV).toBe("production");
  });

  test("the function timeout is applied locally too", () => {
    const plan = localRunPlan(
      { type: "function", runtime: "node", start: "api.js", timeoutSeconds: 45 },
      { root: "/work/app", port: 3000 },
    );
    expect(plan.env.QUAI_TIMEOUT_MS).toBe("45000");
  });

  test("a static project is served, not executed", () => {
    const plan = localRunPlan({ type: "static" }, { root: "/work/app", port: 3000 });
    expect(plan.serveStatic).toBe("/work/app");
    expect(plan.command).toEqual([]);
  });

  test("a static project with a build output serves that instead", () => {
    const plan = localRunPlan(
      { type: "static", build: { output: "dist" } },
      { root: "/work/app", port: 3000 },
    );
    expect(plan.serveStatic).toBe("/work/app/dist");
  });

  test("a service without a start command is refused", () => {
    expect(() => localRunPlan({ type: "service" }, { root: "/work/app", port: 3000 })).toThrow(
      /start/i,
    );
  });

  test("the working directory is the project root", () => {
    const plan = localRunPlan(
      { type: "service", start: "node server.js" },
      { root: "/work/app", port: 3000 },
    );
    expect(plan.cwd).toBe("/work/app");
  });
});

// A folder served locally must answer exactly as it will once deployed:
// anything else lets a path work on a laptop and fail in production, which is
// the one thing 'quai dev' exists to rule out.
describe("serving a static folder locally", () => {
  const ROOT = "/work/app/dist";

  test("the root path serves the index, as it does on the server", () => {
    expect(localStaticFile(ROOT, "/")?.path).toBe(ROOT + "/index.html");
  });

  test("a file is served with the type the server would send", () => {
    expect(localStaticFile(ROOT, "/app.js")?.contentType).toBe("text/javascript; charset=utf-8");
  });

  test("a traversal is refused locally, as it is on the server", () => {
    expect(localStaticFile(ROOT, "/../../etc/passwd")).toBeNull();
  });

  test("a malformed percent-encoding is refused rather than throwing", () => {
    expect(localStaticFile(ROOT, "/%")).toBeNull();
  });
});

// The configuration is the source of truth, so a declared port is the port
// that serves. Anything else would mean 'quai dev' verifies something other
// than what the developer wrote.
describe("which port serves", () => {
  test("a service is served on the port it declares", () => {
    expect(localPort({ type: "service", start: "node server.js", internalPort: 8080 })).toBe(8080);
  });

  test("an explicit --port wins, so several projects can run at once", () => {
    expect(localPort({ type: "service", start: "node server.js", internalPort: 8080 }, 4321)).toBe(
      4321,
    );
  });

  test("a project that declares nothing falls back to a documented default", () => {
    expect(localPort({ type: "static" })).toBe(3000);
  });
});

describe("which directory is run", () => {
  test("a directory is used whether or not a port flag follows it", () => {
    // Without the flag there is no index to skip, and skipping one anyway
    // silently dropped the directory and ran the current one instead.
    expect(devDirectory(["/work/app"])).toBe("/work/app");
    expect(devDirectory(["/work/app", "--port", "4321"])).toBe("/work/app");
  });

  test("the port value is not mistaken for a directory", () => {
    expect(devDirectory(["--port", "4321"])).toBeUndefined();
  });

  test("no argument means the current directory", () => {
    expect(devDirectory([])).toBeUndefined();
  });
});
