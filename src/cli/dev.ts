/**
 * Running a project on the developer's machine.
 *
 * A function is served by the same host the server uses, so a handler that
 * works here works there. Anything else would let a function pass locally and
 * fail on deploy, which is the whole reason to have a dev command.
 */

import { join } from "node:path";
import type { DeploySpec } from "./manifest";
import { isReservedEnvKey } from "./env";
import { contentTypeFor, resolveStaticFile } from "../supervisor/static";

/**
 * The directory a dev run targets, or undefined for the current one.
 *
 * The value after a port flag is not a directory. When no flag is present
 * there is no such value to skip — and skipping one regardless used to drop
 * the directory itself, running the current one in silence.
 */
export function devDirectory(args: string[]): string | undefined {
  const flagIndex = args.findIndex((argument) => argument === "--port" || argument === "-p");
  return args.find(
    (argument, index) => !argument.startsWith("-") && (flagIndex === -1 || index !== flagIndex + 1),
  );
}

/** Where a project is served when it declares nothing. */
export const DEFAULT_LOCAL_PORT = 3000;

/**
 * The variables a project runs with locally.
 *
 * The manifest first, the local file over it — so a value can be changed
 * without editing a tracked file — and the names Quai assigns itself excluded
 * from both. That exclusion is what keeps PORT meaning the same thing here as
 * on the server: a project that moved it would answer where nobody looks.
 */
export function localEnv(
  manifest: Record<string, string> | undefined,
  local: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries({ ...manifest, ...local })) {
    if (!isReservedEnvKey(key)) merged[key] = value;
  }

  return merged;
}

/**
 * What running locally cannot give a project.
 *
 * Named rather than simulated: every one of these is enforced by the kernel
 * around a deployed project, and none of it exists around a plain process on a
 * laptop.
 */
const NOT_REPRODUCED = [
  "memory and CPU caps",
  "the process ceiling",
  "the disk quota",
  "network isolation",
  "syscall confinement",
];

export type StartupFacts = {
  spec: DeploySpec;
  port: number;
  root: string;
  /** The interpreter's own version, or null when it could not be asked. */
  runtimeVersion: string | null;
  variableCount: number;
  /** Which files contributed variables, in the order they were applied. */
  variableSources: string[];
  serveStatic: string | null;
};

/**
 * The lines a dev run prints before it starts.
 *
 * Pure, so what a developer reads is verified without starting anything. It
 * reports decisions rather than intentions: this is how the manifest was
 * understood, and here is what local execution leaves out.
 */
export function startupSummary(facts: StartupFacts): string[] {
  const lines = [`${facts.spec.type} on http://localhost:${facts.port}`];

  if (facts.spec.runtime) {
    lines.push(`  runtime    ${facts.spec.runtime} ${facts.runtimeVersion ?? "(version unknown)"}`);
  }

  if (facts.serveStatic !== null) {
    lines.push(`  serving    ${facts.serveStatic}`);
  } else if (facts.spec.start) {
    lines.push(`  command    ${facts.spec.start}`);
  }

  lines.push(
    facts.variableSources.length === 0
      ? "  env        none"
      : `  env        ${facts.variableCount} from ${facts.variableSources.join(", ")}`,
  );

  lines.push(`  not reproduced locally: ${NOT_REPRODUCED.join(", ")}`);

  return lines;
}

/**
 * The port a project is served on locally.
 *
 * A service declaring an internal port gets that port: on the server it owns a
 * network namespace and listens there, so serving it anywhere else locally
 * would test a configuration nobody wrote. An explicit override still wins,
 * which is how two projects run side by side on one machine.
 */
export function localPort(spec: DeploySpec, override?: number): number {
  return override ?? spec.internalPort ?? DEFAULT_LOCAL_PORT;
}

/** A file to serve, resolved the way the deployed project would resolve it. */
export type LocalStaticFile = { path: string; contentType: string };

/**
 * Resolves a request against a local static folder.
 *
 * Delegates to the supervisor's own resolution rather than reimplementing it:
 * a second implementation would drift, and the drift would only show up after
 * a deploy — the one moment 'quai dev' is meant to make uneventful.
 *
 * @returns null when the request cannot be served, which the caller answers
 * with a 404 rather than explaining why.
 */
export function localStaticFile(root: string, requestPath: string): LocalStaticFile | null {
  const path = resolveStaticFile(root, requestPath);
  return path === null ? null : { path, contentType: contentTypeFor(path) };
}

/** Where the hosts live relative to this file, in a checkout or a build. */
const HOSTS: Record<string, string> = {
  node: "node-host.mjs",
  bun: "bun-host.ts",
  python: "python_host.py",
};

const INTERPRETERS: Record<string, string> = {
  node: "node",
  bun: "bun",
  python: "python3",
};

export type LocalRunOptions = {
  root: string;
  port: number;
  /** Variables read from a local env file, if the project has one. */
  localEnvFile?: Record<string, string>;
  /** Where the function hosts are; defaults to the installed CLI's copy. */
  hostsDirectory?: string;
};

export type LocalRunPlan = {
  command: string[];
  env: Record<string, string>;
  cwd: string;
  /** Set for a static project: the directory to serve, with no process. */
  serveStatic: string | null;
};

export function localRunPlan(spec: DeploySpec, options: LocalRunOptions): LocalRunPlan {
  const hosts = options.hostsDirectory ?? join(import.meta.dir, "..", "hosts");

  if (spec.type === "static") {
    return {
      command: [],
      env: {},
      cwd: options.root,
      // A build output ships instead of the sources, so that is what to serve.
      serveStatic: spec.build?.output ? join(options.root, spec.build.output) : options.root,
    };
  }

  if (!spec.start) {
    throw new Error(
      "This project needs a start command. Add one to quai.toml:\n\n" +
        '  [service]\n  start = "node server.js"',
    );
  }

  // On the server each project owns a network namespace, so its declared port
  // is free. On a laptop they share one, so the developer picks the port.
  const env: Record<string, string> = {
    ...localEnv(spec.env, options.localEnvFile ?? {}),
    PORT: String(options.port),
  };

  if (spec.type === "function") {
    const runtime = spec.runtime ?? "node";
    env.QUAI_HANDLER = spec.start;
    env.QUAI_TIMEOUT_MS = String((spec.timeoutSeconds ?? 30) * 1000);

    return {
      command: [INTERPRETERS[runtime]!, join(hosts, HOSTS[runtime]!)],
      env,
      cwd: options.root,
      serveStatic: null,
    };
  }

  return {
    command: spec.start.split(" "),
    env,
    cwd: options.root,
    serveStatic: null,
  };
}
