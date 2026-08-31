import { describe, expect, test } from "bun:test";
import { ProjectSupervisor, type RunHandle, type RunSpec, type Runner } from "./runner";

/** A Runner whose processes can be made to die on command. */
class FlakyRunner implements Runner {
  readonly starts: string[] = [];
  private alive = new Set<string>();

  async start(spec: RunSpec): Promise<RunHandle> {
    this.starts.push(spec.project);
    this.alive.add(spec.project);
    return { project: spec.project, pid: 1, port: spec.internalPort };
  }

  async stop(project: string) {
    this.alive.delete(project);
  }

  async status(project: string) {
    return this.alive.has(project)
      ? { state: "running" as const, pid: 1 }
      : { state: "stopped" as const };
  }

  crash(project: string) {
    this.alive.delete(project);
  }
}

const spec = (project: string): RunSpec => ({
  project,
  uid: 10000,
  home: "/home/" + project,
  command: ["node", "server.js"],
  internalPort: 8080,
  env: {},
});

describe("bringing a crashed service back", () => {
  test("a crashed project is started again", async () => {
    const runner = new FlakyRunner();
    const supervisor = new ProjectSupervisor(runner);

    await supervisor.start(spec("api"));
    runner.crash("api");
    await supervisor.reviveCrashed(() => 0);

    expect(runner.starts).toEqual(["api", "api"]);
  });

  test("a healthy project is left alone", async () => {
    const runner = new FlakyRunner();
    const supervisor = new ProjectSupervisor(runner);

    await supervisor.start(spec("api"));
    await supervisor.reviveCrashed(() => 0);

    expect(runner.starts).toEqual(["api"]);
  });

  test("a project stopped on purpose is not resurrected", async () => {
    // Otherwise 'quai rm' would fight the supervisor.
    const runner = new FlakyRunner();
    const supervisor = new ProjectSupervisor(runner);

    await supervisor.start(spec("api"));
    await supervisor.stop("api");
    await supervisor.reviveCrashed(() => 0);

    expect(runner.starts).toEqual(["api"]);
  });

  test("a project that keeps crashing is eventually abandoned", async () => {
    const runner = new FlakyRunner();
    let clock0 = 0;
    const supervisor = new ProjectSupervisor(runner, () => clock0);
    await supervisor.start(spec("api"));

    // A project that crashes on startup dies again within seconds, so the
    // clock barely moves between attempts. Advancing an hour each time would
    // read as a healthy run and the backoff would never build.
    let clock = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      runner.crash("api");
      clock += 30_000;
      await supervisor.reviveCrashed(() => clock);
    }

    expect(runner.starts.length).toBeLessThan(40);
    expect(await supervisor.status("api")).toMatchObject({ state: "crashed" });
  });

  test("an abandoned project is reported, not silently dropped", async () => {
    const runner = new FlakyRunner();
    const supervisor = new ProjectSupervisor(runner, () => 0);
    await supervisor.start(spec("api"));

    let clock = 0;
    const abandoned: string[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      runner.crash("api");
      clock += 30_000;
      await supervisor.reviveCrashed(() => clock, (project) => abandoned.push(project));
    }

    expect(abandoned).toContain("api");
  });

  test("one failing project does not stop another from being revived", async () => {
    const runner = new FlakyRunner();
    const supervisor = new ProjectSupervisor(runner);
    await supervisor.start(spec("broken"));
    await supervisor.start(spec("fine"));

    runner.crash("broken");
    runner.crash("fine");
    await supervisor.reviveCrashed(() => 0);

    expect(runner.starts.filter((p) => p === "fine")).toHaveLength(2);
  });

  test("redeploying clears the failure record", async () => {
    const runner = new FlakyRunner();
    const supervisor = new ProjectSupervisor(runner, () => 0);
    await supervisor.start(spec("api"));

    let clock = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      runner.crash("api");
      clock += 30_000;
      await supervisor.reviveCrashed(() => clock);
    }

    // A deploy is the operator saying the project is fixed.
    await supervisor.start(spec("api"));
    runner.crash("api");
    const before = runner.starts.length;
    await supervisor.reviveCrashed(() => clock);

    expect(runner.starts.length).toBe(before + 1);
  });
});

