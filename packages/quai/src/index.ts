/**
 * Types for Quai projects.
 *
 * Everything here exists for the type checker and the editor. The helpers
 * return their argument untouched: a wrapper would make the code that runs on
 * the server differ from the code that was written, which is exactly what a
 * typing package should not do.
 */

/**
 * The Node request and response, described structurally rather than imported.
 *
 * Importing node:http would force @types/node on everyone, including projects
 * that only deploy a static site or a Bun function. The shape below is what a
 * handler actually uses; a real IncomingMessage satisfies it.
 */
export type QuaiRequest = {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: never[]) => void): unknown;
};

export type QuaiResponse = {
  statusCode: number;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  end(body?: string | Uint8Array): unknown;
  write(chunk: string | Uint8Array): unknown;
};

/**
 * What a handler may return.
 *
 * Anything, and it is ignored: writing `res.end(...)` as the last expression
 * of an arrow function returns whatever end() gives back, and rejecting that
 * would fail the most natural way to write a handler.
 */
type HandlerResult = unknown;

// --- functions ------------------------------------------------------------

/**
 * A Node function.
 *
 * Quai supplies the server; the handler decides what a request produces. It
 * may be exported as `default` or as `handler`.
 */
export type QuaiHandler = (request: QuaiRequest, response: QuaiResponse) => HandlerResult;

/** A Bun function, written against the platform's fetch-style handler. */
export type QuaiBunHandler = (request: Request) => Response | Promise<Response>;

/** Identity at runtime; it is the type annotation that does the work. */
export function defineHandler(handler: QuaiHandler): QuaiHandler {
  return handler;
}

/** Identity at runtime, as above. */
export function defineBunHandler(handler: QuaiBunHandler): QuaiBunHandler {
  return handler;
}

// --- manifest -------------------------------------------------------------

export type ProjectType = "static" | "service" | "function";
export type Runtime = "node" | "bun" | "python";

export type QuaiConfig = {
  /** Defaults to the directory name, which is what makes redeploys idempotent. */
  name?: string;
  type: ProjectType;
  runtime?: Runtime;

  /** Runs on your machine. Only the output is uploaded. */
  build?: {
    command?: string;
    /** Directory to ship instead of the whole project. */
    output?: string;
  };

  service?: {
    /** Declared, never guessed: the process listens where it says it does. */
    internalPort?: number;
    start?: string;
  };

  limits?: {
    /** e.g. "256Mi", "1Gi". Absent means Quai's default. */
    memory?: string;
    /** Fraction of a core, e.g. "0.5". */
    cpu?: string;
    /** Maximum processes; this is what stops a fork bomb. */
    pids?: number;
    disk?: string;
    /** Functions only, e.g. "30s". */
    timeout?: string;
  };

  domains?: {
    /** Served alongside the automatic subdomain, never instead of it. */
    custom?: string[];
  };

  env?: Record<string, string>;
};

/** Identity at runtime; use it to get completion and checking on a manifest. */
export function defineConfig(config: QuaiConfig): QuaiConfig {
  return config;
}
