import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceRunningBinary, uninstallPlan } from "./self-update";

describe("replacing the binary that is running", () => {
  test("the new binary ends up in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quai-up-"));
    const current = join(dir, "quai");
    const staged = join(dir, "quai.new");
    await writeFile(current, "old");
    await writeFile(staged, "new");

    await replaceRunningBinary(current, staged);
    expect(await readFile(current, "utf8")).toBe("new");
  });

  test("the replacement is executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quai-up-"));
    const current = join(dir, "quai");
    const staged = join(dir, "quai.new");
    await writeFile(current, "old");
    await writeFile(staged, "new");

    await replaceRunningBinary(current, staged);
    expect((await stat(current)).mode & 0o111).toBeGreaterThan(0);
  });

  test("the old binary is moved aside rather than deleted first", async () => {
    // A running program cannot have its file removed out from under it on
    // every platform; renaming keeps the inode alive until it exits.
    const dir = await mkdtemp(join(tmpdir(), "quai-up-"));
    const current = join(dir, "quai");
    const staged = join(dir, "quai.new");
    await writeFile(current, "old");
    await writeFile(staged, "new");

    const moved = await replaceRunningBinary(current, staged);
    expect(moved).toContain(".old");
  });

  test("a failure leaves the working binary in place", async () => {
    // Half-updating the tool that performs updates would leave no way to
    // recover except reinstalling by hand.
    const dir = await mkdtemp(join(tmpdir(), "quai-up-"));
    const current = join(dir, "quai");
    await writeFile(current, "old");

    await expect(
      replaceRunningBinary(current, join(dir, "does-not-exist")),
    ).rejects.toThrow();
    expect(await readFile(current, "utf8")).toBe("old");
  });

  test("a leftover from a previous update does not block a new one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quai-up-"));
    const current = join(dir, "quai");
    const staged = join(dir, "quai.new");
    await writeFile(current, "old");
    await writeFile(staged, "new");
    await writeFile(current + ".old", "stale");

    await replaceRunningBinary(current, staged);
    expect(await readFile(current, "utf8")).toBe("new");
  });
});

describe("uninstalling", () => {
  test("the binary is removed", async () => {
    const plan = uninstallPlan("/home/me/.local/bin/quai", "/home/me/.config/quai");
    expect(plan.binary).toBe("/home/me/.local/bin/quai");
  });

  test("the login configuration is offered for removal", () => {
    const plan = uninstallPlan("/usr/local/bin/quai", "/home/me/.config/quai");
    expect(plan.config).toBe("/home/me/.config/quai");
  });

  test("nothing outside those two paths is touched", () => {
    // Uninstalling a CLI must never reach a user's projects or a server's
    // deployments.
    const plan = uninstallPlan("/usr/local/bin/quai", "/home/me/.config/quai");
    expect(Object.values(plan)).toHaveLength(2);
  });

  test("the plan names absolute paths, so nothing is resolved by chance", () => {
    const plan = uninstallPlan("/usr/local/bin/quai", "/home/me/.config/quai");
    for (const path of Object.values(plan)) {
      expect(path.startsWith("/")).toBe(true);
    }
  });
});

