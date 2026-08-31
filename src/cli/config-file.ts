/**
 * Loading a project's configuration.
 *
 * A manifest can be a quai.toml or a quai.config.ts / .js exporting an object.
 * The typed form exists because the types package offers defineConfig, and a
 * helper nobody can actually load would be worse than none at all.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { manifestSchema, formatManifestErrors } from "./manifest-schema";
import type { Manifest } from "./manifest";
import { parseQuaiToml } from "./manifest";

/**
 * Candidates, most specific first.
 *
 * A project that added a typed config meant to use it: silently preferring the
 * TOML would ignore what the developer just wrote.
 */
const CANDIDATES = ["quai.config.ts", "quai.config.js", "quai.config.mjs", "quai.toml"] as const;

/** The config file a directory uses, or null when it has none. */
export async function configFileIn(directory: string): Promise<string | null> {
  return CANDIDATES.find((candidate) => existsSync(join(directory, candidate))) ?? null;
}

/**
 * The typed API spells fields in camelCase; the TOML spells them with
 * underscores. Both describe the same manifest, so one is translated into the
 * other rather than telling a developer following the types that their config
 * is wrong.
 */
function normalise(config: Record<string, unknown>): Record<string, unknown> {
  const service = config.service as Record<string, unknown> | undefined;
  if (service === undefined || !("internalPort" in service)) return config;

  const { internalPort, ...rest } = service;
  return { ...config, service: { ...rest, internal_port: internalPort } };
}

/**
 * Loads and validates a project's configuration.
 *
 * @returns null when the directory has no config, which is the ordinary case.
 * @throws with the same message a bad quai.toml produces, so the two forms are
 * indistinguishable once something is wrong.
 */
export async function loadProjectConfig(directory: string): Promise<Manifest | null> {
  const file = await configFileIn(directory);
  if (file === null) return null;

  const path = join(directory, file);

  if (file === "quai.toml") {
    return parseQuaiToml(await readFile(path, "utf8"));
  }

  const loaded = (await import(resolve(path))) as { default?: unknown };
  if (loaded.default === undefined) {
    throw new Error(
      `${file} must have a default export. Wrap your config in defineConfig ` +
        "and export it as the default.",
    );
  }

  const result = manifestSchema.safeParse(normalise(loaded.default as Record<string, unknown>));
  if (!result.success) {
    throw new Error(formatManifestErrors(result.error).replace("quai.toml", file));
  }

  return result.data as Manifest;
}
