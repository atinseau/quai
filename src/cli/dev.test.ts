import { describe, expect, test } from "bun:test";
import { localRunPlan } from "./dev";

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
