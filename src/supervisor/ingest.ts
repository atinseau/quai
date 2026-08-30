/**
 * Deploy ingest.
 *
 * Receives an archive over SSH and publishes it. The SSH key is restricted to
 * this single command, so a deploy credential never grants a shell.
 */

import { subdomainOf } from "./naming";
import type { SiteStore } from "./sites";
import type { Store } from "./store";
import { unpackTar } from "./tar";

export type DeployResult = { project: string; url: string; files: number };

export async function deployArchive(
  project: string,
  archive: Uint8Array,
  deps: { sites: SiteStore; store: Store; zone: string },
): Promise<DeployResult> {
  const entries = unpackTar(archive);
  if (entries.length === 0) {
    throw new Error("The uploaded archive contains no files");
  }

  // Publish first: if writing the content fails, the record must not claim a
  // project that cannot be served.
  await deps.sites.publish(project, entries);

  deps.store.transaction(() => {
    deps.store.allocateUid(project);
    deps.store.upsertProject({ name: project, type: "static" });
  });

  return {
    project,
    url: "https://" + subdomainOf(project, deps.zone),
    files: entries.length,
  };
}

