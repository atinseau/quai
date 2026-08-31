import { describe, expect, test, beforeEach } from "bun:test";
import { ProjectSupervisor, type Runner, type RunHandle, type RunSpec } from "./runner";

/**
 * A Runner that records what it was asked to do, without touching the system.
 * The whole point of the seam: everything above it is testable this way, and
 * the real implementation can later be swapped for micro-VMs.
 */
class FakeRunner implements Runner {
  readonly started: RunSpec[] = [];
  readonly stopped: string[] = [];
  private handles = new Map<string, RunHandle>();
  failNext: string | null = null;

  async start(spec: RunSpec): Promise<RunHandle> {
    if (this.failNext === spec.project) {
      this.failNext = null;
      throw new Error("could not start: port already bound");
    }
    this.started.push(spec);
    const handle: RunHandle = { project: spec.project, pid: 4242, port: spec.internalPort };
    this.handles.set(spec.project, handle);
    return handle;
  }

  async stop(project: string): Promise<void> {
    this.stopped.push(project);
    this.handles.delete(project);
  }

  async status(project: string) {
    const handle = this.handles.get(project);
    return handle ? { state: "running" as const, pid: handle.pid } : { state: "stopped" as const };
  }

  /** Simulates the process dying on its own. */
  crash(project: string): void {
    this.handles.delete(project);
  }
}

const spec = (project: string): RunSpec => ({
  project,
  uid: 10000,
  home: "/home/quai-" + project,
  command: ["node", "server.js"],
  internalPort: 8080,
  env: {},
});

let runner: FakeRunner;
let supervisor: ProjectSupervisor;

beforeEach(() => {
  runner = new FakeRunner();
  supervisor = new ProjectSupervisor(runner);
});

describe("project supervision", () => {
  test("starting a service makes it running", async () => {
    await supervisor.start(spec("alpha"));
    expect(await supervisor.status("alpha")).toMatchObject({ state: "running" });
  });

  test("the run carries the project's own uid, never root", async () => {
    await supervisor.start({ ...spec("alpha"), uid: 10007 });
    expect(runner.started[0]!.uid).toBe(10007);
    expect(runner.started[0]!.uid).not.toBe(0);
  });

  test("a stopped project reports stopped", async () => {
    await supervisor.start(spec("alpha"));
    await supervisor.stop("alpha");
    expect(await supervisor.status("alpha")).toMatchObject({ state: "stopped" });
  });

  test("an unknown project reports stopped rather than throwing", async () => {
    expect(await supervisor.status("never-deployed")).toMatchObject({ state: "stopped" });
  });

  test("restarting a project replaces the previous run", async () => {
    await supervisor.start(spec("alpha"));
    await supervisor.start(spec("alpha"));
    expect(runner.stopped).toEqual(["alpha"]);
    expect(await supervisor.status("alpha")).toMatchObject({ state: "running" });
  });

  test("a crashed service is reported as crashed, not as running", async () => {
    await supervisor.start(spec("alpha"));
    runner.crash("alpha");
    expect(await supervisor.status("alpha")).toMatchObject({ state: "crashed" });
  });

  test("a crashed service does not affect its neighbours", async () => {
    await supervisor.start(spec("alpha"));
    await supervisor.start(spec("beta"));
    runner.crash("alpha");
    expect(await supervisor.status("beta")).toMatchObject({ state: "running" });
  });

  test("a service that fails to start is reported as failed with its reason", async () => {
    runner.failNext = "alpha";
    await expect(supervisor.start(spec("alpha"))).rejects.toThrow(/port already bound/);
    expect(await supervisor.status("alpha")).toMatchObject({ state: "stopped" });
  });

  test("a failed start does not prevent another project from starting", async () => {
    runner.failNext = "alpha";
    await supervisor.start(spec("alpha")).catch(() => {});
    await supervisor.start(spec("beta"));
    expect(await supervisor.status("beta")).toMatchObject({ state: "running" });
  });

  test("stopping a project that never ran is not an error", async () => {
    await expect(supervisor.stop("ghost")).resolves.toBeUndefined();
  });

  test("running projects are listed", async () => {
    await supervisor.start(spec("alpha"));
    await supervisor.start(spec("beta"));
    expect(supervisor.running().toSorted()).toEqual(["alpha", "beta"]);
  });

  test("stopping everything leaves nothing running", async () => {
    await supervisor.start(spec("alpha"));
    await supervisor.start(spec("beta"));
    await supervisor.stopAll();
    expect(supervisor.running()).toEqual([]);
  });
});
