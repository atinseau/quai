/**
 * Running a project on the developer's machine.
 *
 * A function is served by the same host the server uses, so a handler that
 * works here works there. Anything else would let a function pass locally and
 * fail on deploy, which is the whole reason to have a dev command.
 */

import { join } from "node:path";
import type { DeploySpec } from "./manifest";

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
  const env: Record<string, string> = { ...(spec.env ?? {}), PORT: String(options.port) };

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

