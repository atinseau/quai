/**
 * Client configuration.
 *
 * "quai login" writes the instance once so that every later deploy is a bare
 * "quai" from the project directory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ClientConfig = {
  /** SSH destination of the Quai instance, e.g. quai@host.example.com */
  host: string;
  /** The wildcard zone projects are served under. */
  zone: string;
};

export function configPath(): string {
  const base = process.env.QUAI_CONFIG_HOME ?? join(homedir(), ".config", "quai");
  return join(base, "config.json");
}

export async function readConfig(): Promise<ClientConfig | null> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as ClientConfig;
  } catch {
    return null;
  }
}

export async function writeConfig(config: ClientConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

