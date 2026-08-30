/**
 * Deploy ingest.
 *
 * Receives an archive over SSH and publishes it. The SSH key is restricted to
 * this single command, so a deploy credential never grants a shell.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { subdomainOf } from "./naming";
import { DEFAULT_DISK_QUOTA } from "./quota";
import type { ProjectSupervisor } from "./runner";
import type { SiteStorage } from "./sites";
import type { Store } from "./store";
import { unpackTar } from "./tar";
import { safeExtractPath } from "./unpack";

export type DeploySpec = {
  type: "static" | "service" | "function";
  /** Start command for a service, ignored for a static project. */
  start?: string;
  internalPort?: number;
};

export type DeployResult = {
  project: string;
  url: string;
  files: number;
  type: string;
};

export type DeployDeps = {
  sites: SiteStorage;
  store: Store;
  zone: string;
  projects: ProjectSupervisor;
  ensureAccount: (project: string, uid: number) => Promise<void>;
  /** Where a project's own files live. Injected so tests need no real homes. */
  homeFor: (project: string) => string;
  /** Hands a directory to the project's uid. Injected for the same reason. */
  chown?: (path: string, uid: number) => Promise<void>;
  /** Set false where network namespaces are unavailable, such as in tests. */
  isolateNetwork?: boolean;
  /** Caps the space a project may occupy. Absent where quotas are unavailable. */
  applyQuota?: (project: string, uid: number, limit: string) => Promise<void>;
};

export async function deployArchive(
  project: string,
  archive: Uint8Array,
  spec: DeploySpec,
  deps: DeployDeps,
): Promise<DeployResult> {
  const entries = unpackTar(archive);
  if (entries.length === 0) {
    throw new Error("The uploaded archive contains no files");
  }

  const uid = deps.store.allocateUid(project);



  if (spec.type === "static") {
    // A static project never starts a process: the router serves it straight
    // from disk, so it costs nothing when idle.
    await deps.sites.publish(project, entries);

    // Marking has to follow publication: an atomic publish renames the
    // directory into place, and a rename does not carry the project attribute
    // with it. Marking earlier leaves the content on project 0, uncapped.
    await deps.applyQuota?.(project, uid, DEFAULT_DISK_QUOTA);
    deps.store.upsertProject({ name: project, type: "static" });
  } else {
    if (!spec.start) {
      throw new Error("A service must declare its start command");
    }

    await deps.ensureAccount(project, uid);

    // Content lands in the project's own home, owned by its uid, which is what
    // keeps a neighbour from reading it.
    const home = deps.homeFor(project);
    for (const entry of entries) {
      const destination = safeExtractPath(home, entry.name);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, entry.contents);
    }
    await deps.chown?.(home, uid);
    await deps.applyQuota?.(project, uid, DEFAULT_DISK_QUOTA);

    const internalPort = spec.internalPort ?? 8080;
    deps.store.upsertProject({
      name: project,
      type: spec.type,
      internalPort,
      command: spec.start,
    });

    await deps.projects.start({
      project,
      uid,
      home,
      command: spec.start.split(" "),
      internalPort,
      env: deps.store.getEnv(project),
      namespaceIndex: deps.store.lookup(project)?.netnsIndex ?? 0,
      isolateNetwork: deps.isolateNetwork,
    });
  }

  return {
    project,
    url: "https://" + subdomainOf(project, deps.zone),
    files: entries.length,
    type: spec.type,
  };
}

