import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFileIn, loadProjectConfig } from "./config-file";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "quai-config-"));
});

describe("finding the config a project uses", () => {
  test("a quai.toml is found", async () => {
    await writeFile(join(directory, "quai.toml"), 'type = "static"');
    expect(await configFileIn(directory)).toBe("quai.toml");
  });

  test("a quai.config.ts is found", async () => {
    await writeFile(join(directory, "quai.config.ts"), "export default {};");
    expect(await configFileIn(directory)).toBe("quai.config.ts");
  });

  test("a quai.config.js is found", async () => {
    await writeFile(join(directory, "quai.config.js"), "export default {};");
    expect(await configFileIn(directory)).toBe("quai.config.js");
  });

  test("a directory with no config reports none", async () => {
    expect(await configFileIn(directory)).toBeNull();
  });

  test("TypeScript wins over TOML, since it is the more specific choice", async () => {
    // A project that added a typed config meant to use it; silently preferring
    // the TOML would ignore what the developer just wrote.
    await writeFile(join(directory, "quai.toml"), 'type = "static"');
    await writeFile(join(directory, "quai.config.ts"), "export default {};");
    expect(await configFileIn(directory)).toBe("quai.config.ts");
  });
});

describe("loading a typed config", () => {
  test("a default export becomes the manifest", async () => {
    await writeFile(
      join(directory, "quai.config.ts"),
      'export default { type: "service", service: { start: "node server.js" } };',
    );
    const config = await loadProjectConfig(directory);
    expect(config).toMatchObject({ type: "service" });
  });

  test("the camelCase form used by defineConfig is accepted", async () => {
    // The types expose internalPort; the TOML spells it internal_port. A
    // developer following the typed API must not be told their config is wrong.
    await writeFile(
      join(directory, "quai.config.ts"),
      'export default { type: "service", service: { internalPort: 3000, start: "node s.js" } };',
    );
    const config = await loadProjectConfig(directory);
    expect(config?.service?.internal_port).toBe(3000);
  });

  test("limits and env survive the load", async () => {
    await writeFile(
      join(directory, "quai.config.ts"),
      `export default {
         type: "service",
         service: { start: "node s.js" },
         limits: { memory: "512Mi", pids: 128 },
         env: { NODE_ENV: "production" },
       };`,
    );
    const config = await loadProjectConfig(directory);
    expect(config?.limits?.memory).toBe("512Mi");
    expect(config?.env?.NODE_ENV).toBe("production");
  });

  test("a config wrapped in defineConfig loads the same way", async () => {
    // defineConfig returns its argument, so the wrapper must be invisible here.
    await writeFile(
      join(directory, "quai.config.js"),
      'const defineConfig = (c) => c;\nexport default defineConfig({ type: "static" });',
    );
    expect(await loadProjectConfig(directory)).toMatchObject({ type: "static" });
  });

  test("an invalid config is refused with the same message as a TOML one", async () => {
    await writeFile(join(directory, "quai.config.ts"), 'export default { type: "magic" };');
    await expect(loadProjectConfig(directory)).rejects.toThrow(/type/);
  });

  test("a config that throws is reported with its own error", async () => {
    await writeFile(join(directory, "quai.config.ts"), 'throw new Error("boom");');
    await expect(loadProjectConfig(directory)).rejects.toThrow(/boom/);
  });

  test("a config exporting nothing is refused clearly", async () => {
    await writeFile(join(directory, "quai.config.ts"), "export const other = 1;");
    await expect(loadProjectConfig(directory)).rejects.toThrow(/default export/i);
  });

  test("a TOML project still loads", async () => {
    await writeFile(join(directory, "quai.toml"), 'type = "static"\nname = "site"');
    expect(await loadProjectConfig(directory)).toMatchObject({ type: "static", name: "site" });
  });

  test("a directory with no config loads nothing, which is not an error", async () => {
    expect(await loadProjectConfig(directory)).toBeNull();
  });
});
