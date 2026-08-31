/**
 * Function hosting.
 *
 * A function is a single exported handler rather than a server: the developer
 * writes what happens on a request, and Quai supplies the listening, the
 * lifecycle and the timeout. Each runtime gets a small host that turns its
 * native handler shape into an HTTP server.
 */

import type { Runtime } from "../cli/manifest";

/** Long enough for real work, short enough that a stuck request is noticed. */
export const DEFAULT_FUNCTION_TIMEOUT = "30s";

const HOSTS: Record<Runtime, { interpreter: string; host: string }> = {
  node: { interpreter: "/usr/bin/node", host: "/opt/quai/src/hosts/node-host.mjs" },
  bun: { interpreter: "/usr/local/bin/bun", host: "/opt/quai/src/hosts/bun-host.ts" },
  python: { interpreter: "/usr/bin/python3", host: "/opt/quai/src/hosts/python_host.py" },
};

export type FunctionHost = {
  command: string[];
  env: Record<string, string>;
};

/**
 * Builds the command that serves a handler.
 *
 * @throws on a runtime with no host, rather than falling through to a service
 * that would never answer.
 */
export function functionHostFor(
  runtime: Runtime,
  handlerPath: string,
  timeoutSeconds: number,
): FunctionHost {
  const host = HOSTS[runtime];
  if (host === undefined) {
    throw new Error(
      `No function runtime for '${runtime}'. Supported: ${Object.keys(HOSTS).join(", ")}.`,
    );
  }

  return {
    command: [host.interpreter, host.host],
    env: {
      QUAI_HANDLER: handlerPath,
      QUAI_TIMEOUT_MS: String(timeoutSeconds * 1000),
    },
  };
}
