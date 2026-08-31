import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentLog } from "./log-file";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "quai-logs-"));
});

describe("logs that outlive the supervisor", () => {
  test("what a project wrote is readable after reopening", async () => {
    // In-memory logs vanish on restart, which makes a crash during the night
    // impossible to diagnose.
    const log = new PersistentLog(directory, "api");
    await log.append("starting up\n");
    await log.flush();

    expect(await new PersistentLog(directory, "api").read()).toContain("starting up");
  });

  test("successive writes accumulate", async () => {
    const log = new PersistentLog(directory, "api");
    await log.append("one\n");
    await log.append("two\n");
    await log.flush();

    const contents = await log.read();
    expect(contents).toContain("one");
    expect(contents).toContain("two");
  });

  test("two projects keep separate logs", async () => {
    const alpha = new PersistentLog(directory, "alpha");
    const beta = new PersistentLog(directory, "beta");
    await alpha.append("from alpha\n");
    await beta.append("from beta\n");
    await alpha.flush();
    await beta.flush();

    expect(await beta.read()).not.toContain("from alpha");
  });

  test("a chatty project cannot fill the volume", async () => {
    // Bounded on purpose: an unbounded log would eventually take the disk every
    // other project depends on.
    const log = new PersistentLog(directory, "api", { maxBytes: 1024 });
    for (let i = 0; i < 500; i++) await log.append(`line ${i} padded out\n`);
    await log.flush();

    const size = (await log.read()).length;
    expect(size).toBeLessThanOrEqual(4096);
  });

  test("rotation keeps the most recent output, not the oldest", async () => {
    const log = new PersistentLog(directory, "api", { maxBytes: 512 });
    for (let i = 0; i < 200; i++) await log.append(`line ${i}\n`);
    await log.flush();

    const contents = await log.read();
    expect(contents).toContain("line 199");
    expect(contents).not.toContain("line 0\n");
  });

  test("reading a project that never logged yields nothing", async () => {
    expect(await new PersistentLog(directory, "silent").read()).toBe("");
  });

  test("removing a project takes its log with it", async () => {
    const log = new PersistentLog(directory, "api");
    await log.append("something\n");
    await log.flush();
    await log.remove();

    expect(await readdir(directory)).toEqual([]);
  });

  test("a project name cannot escape the log directory", async () => {
    // The name reaches this from a deploy request, so it is untrusted.
    expect(() => new PersistentLog(directory, "../../etc/passwd")).toThrow(/name/i);
  });

  test("writes survive a corrupted existing file rather than throwing", async () => {
    await writeFile(join(directory, "api.log"), "\u0000\u0000garbage");
    const log = new PersistentLog(directory, "api");
    await log.append("after\n");
    await log.flush();

    expect(await log.read()).toContain("after");
  });
});


describe("a quiet project still reaches disk", () => {
  test("a single line is written without waiting for a full batch", async () => {
    // Batching alone meant a service logging once at startup never reached the
    // threshold, so nothing was ever written — exactly the case the file is for.
    const log = new PersistentLog(directory, "quiet");
    await log.append("started\n");

    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const onDisk = await readFile(join(directory, "quiet.log"), "utf8").catch(() => "");
    expect(onDisk).toContain("started");
  });

  test("an explicit flush does not wait for the timer", async () => {
    const log = new PersistentLog(directory, "quiet");
    await log.append("now\n");
    await log.flush();

    expect(await readFile(join(directory, "quiet.log"), "utf8")).toContain("now");
  });
});

