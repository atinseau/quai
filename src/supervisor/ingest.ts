/**
 * Deploy ingest.
 *
 * Receives an archive over SSH and publishes it. The SSH key is restricted to
 * this single command, so a deploy credential never grants a shell.
 */

import { unpackTar } from "./tar";
import type { Registry } from "./registry";
import type { SiteStore } from "./sites";
import { subdomainOf } from "./naming";

export type DeployResult = { project: string; url: string; files: number };

export async function deployArchive(
  project: string,
  archive: Uint8Array,
  deps: { store: SiteStore; registry: Registry; zone: string },
): Promise<DeployResult> {
  const entries = unpackTar(archive);
  if (entries.length === 0) {
    throw new Error("The uploaded archive contains no files");
  }

  await deps.store.publish(project, entries);
  await deps.registry.upsert({ name: project, type: "static" });

  return {
    project,
    url: "https://" + subdomainOf(project, deps.zone),
    files: entries.length,
  };
}

