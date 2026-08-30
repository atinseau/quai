/**
 * Deploy ingest.
 *
 * Receives an archive over SSH and publishes it. The SSH key is restricted to
 * this single command, so a deploy credential never grants a shell.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { subdomainOf } from "./naming";
import { DEFAULT_LIMITS } from "./cgroup";
import { DEFAULT_DISK_QUOTA } from "./quota";
import { functionHostFor } from "./function-host";
import type { Runtime } from "../cli/manifest";
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
  /** Which runtime hosts a function. */
  runtime?: Runtime;
  /** Seconds a function may run before the caller gets a definite answer. */
  timeoutSeconds?: number;
  /** Resource ceilings the project declared; absent values keep the defaults. */
  limits?: { memory?: string; cpu?: string; pids?: number };
  /** Disk ceiling the project declared. */
  diskQuota?: string;
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
  /**
   * Builds a tree at the staging path, then swaps it into place atomically.
   * Injected so tests need no real filesystem.
   */
  replaceTree: (staging: string, build: () => Promise<void>) => Promise<void>;
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
    // The uid owns its content even for a static project, so a neighbour
    // cannot read it straight off the volume.
    await deps.sites.publish(project, entries, uid);

    // Marking has to follow publication: an atomic publish renames the
    // directory into place, and a rename does not carry the project attribute
    // with it. Marking earlier leaves the content on project 0, uncapped.
    await deps.applyQuota?.(project, uid, spec.diskQuota ?? DEFAULT_DISK_QUOTA);
    deps.store.upsertProject({ name: project, type: "static" });
  } else {
    // A function is a handler, not a server: Quai supplies the host that
    // turns it into one, so the developer declares the file rather than a
    // command line.
    const host =
      spec.type === "function"
        ? functionHostFor(
            spec.runtime ?? "node",
            spec.start ?? "index.js",
            spec.timeoutSeconds ?? 30,
          )
        : null;

    if (host === null && !spec.start) {
      throw new Error("A service must declare its start command");
    }

    await deps.ensureAccount(project, uid);

    // Content lands in the project's own home, owned by its uid, which is what
    // keeps a neighbour from reading it.
    //
    // It is unpacked beside the home and swapped in, never written over the
    // previous deploy: the project owns that directory and could have left a
    // symlink there, which the supervisor would follow as root and write
    // wherever it points. A fresh directory has nothing to follow, and the
    // swap also removes files the project no longer ships.
    const home = deps.homeFor(project);
    const staging = home + ".incoming";

    await deps.replaceTree(staging, async () => {
      for (const entry of entries) {
        const destination = safeExtractPath(staging, entry.name);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, entry.contents, { flag: "wx" });
      }
    });

    await deps.chown?.(home, uid);
    await deps.applyQuota?.(project, uid, spec.diskQuota ?? DEFAULT_DISK_QUOTA);

    const internalPort = spec.internalPort ?? 8080;
    deps.store.upsertProject({
      name: project,
      type: spec.type,
      internalPort,
      command: host ? host.command.join(" ") : spec.start,
    });

    // The host reads the handler and timeout from the environment, so they
    // have to be persisted: otherwise a restart relaunches the host with no
    // handler to serve.
    for (const [key, value] of Object.entries(host?.env ?? {})) {
      deps.store.setEnv(project, key, value);
    }

    await deps.projects.start({
      project,
      uid,
      home,
      command: host ? host.command : spec.start!.split(" "),
      internalPort,
      env: { ...deps.store.getEnv(project), ...(host?.env ?? {}) },
      namespaceIndex: deps.store.lookup(project)?.netnsIndex ?? 0,
      limits: {
        memory: spec.limits?.memory ?? DEFAULT_LIMITS.memory,
        cpu: spec.limits?.cpu ?? DEFAULT_LIMITS.cpu,
        pids: spec.limits?.pids ?? DEFAULT_LIMITS.pids,
      },
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

