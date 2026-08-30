/**
 * Project manifest and type detection.
 *
 * The everyday case must stay ceremony-free: a directory of files deploys with
 * no configuration at all. A quai.toml appears only when the project leaves
 * that nominal case. Making it mandatory would rebuild the very ceremony Quai
 * exists to remove.
 *
 * Where detection is ambiguous, Quai refuses rather than guesses: deploying
 * the wrong thing silently is worse than asking for one line of configuration.
 */

export type ProjectType = "static" | "service" | "function";
export type Runtime = "node" | "bun" | "python";

export type Detection = {
  type: ProjectType;
  runtime?: Runtime;
  /** The handler file, when a lone function was recognised. */
  handler?: string;
};

/** Files that name a function all by themselves, most conventional first. */
const FUNCTION_HANDLERS: { file: string; runtime: Runtime }[] = [
  { file: "api.js", runtime: "node" },
  { file: "api.ts", runtime: "bun" },
  { file: "api.py", runtime: "python" },
  { file: "handler.js", runtime: "node" },
  { file: "handler.py", runtime: "python" },
];

export type Manifest = {
  name?: string;
  type: ProjectType;
  runtime?: Runtime;
  build?: { command?: string; output?: string };
  service?: { internal_port?: number; start?: string };
  /** Function timeout, e.g. "30s". */
  timeout?: string;
  limits?: { memory?: string; cpu?: string; pids?: number; disk?: string; timeout?: string };
  domains?: { custom?: string[] };
  env?: Record<string, string>;
};

export type DeploySpec = {
  type: ProjectType;
  runtime?: Runtime;
  start?: string;
  internalPort?: number;
  build?: { command?: string; output?: string };
  limits?: Manifest["limits"];
  domains?: string[];
  env?: Record<string, string>;
  /** Seconds a function may run before the caller gets a definite answer. */
  timeoutSeconds?: number;
};

/** Marker files, most specific first. */
const MARKERS: { files: string[]; detection: Detection }[] = [
  // Bun before Node: a Bun project also carries a package.json.
  { files: ["bun.lockb", "bun.lock"], detection: { type: "service", runtime: "bun" } },
  { files: ["package.json"], detection: { type: "service", runtime: "node" } },
  {
    files: ["requirements.txt", "pyproject.toml"],
    detection: { type: "service", runtime: "python" },
  },
];

/**
 * Infers what a directory holds from the files it contains.
 *
 * @throws when two unrelated ecosystems are present, since either could be the
 * real project and picking one would deploy the wrong thing.
 */
export function detectProjectType(files: Set<string>): Detection | null {
  const matched = MARKERS.filter((marker) => marker.files.some((file) => files.has(file)));

  const runtimes = new Set(matched.map((marker) => marker.detection.runtime));
  // Bun and Node overlap by design; anything else is a genuine conflict.
  const conflicting = runtimes.size > 1 && !(runtimes.size === 2 && runtimes.has("bun"));
  if (conflicting) {
    throw new Error(
      "Ambiguous project: found manifests for " +
        [...runtimes].join(" and ") +
        ". Add a quai.toml declaring which one to deploy.",
    );
  }

  if (matched.length > 0) return matched[0]!.detection;

  // An index.html only means "static" when nothing else claims the directory:
  // a framework's public/index.html must not make the whole project static.
  if (files.has("index.html")) return { type: "static" };

  // A lone handler file is a function: the spec's second story is deploying
  // api.js on its own, with no manifest and no package.json.
  const handler = FUNCTION_HANDLERS.find((candidate) => files.has(candidate.file));
  if (handler !== undefined) {
    return { type: "function", runtime: handler.runtime, handler: handler.file };
  }

  return null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

/**
 * Parses a quai.toml.
 *
 * Only the subset Quai defines is accepted, and an unknown type is refused
 * rather than passed through to fail later at deploy time.
 */
export function parseQuaiToml(source: string): Manifest {
  const parsed = Bun.TOML.parse(source) as Record<string, unknown>;

  const type = requireString(parsed.type, "type");
  if (type !== "static" && type !== "service" && type !== "function") {
    throw new Error(
      `Unknown project type '${type}'. Use one of: static, service, function.`,
    );
  }

  return { ...parsed, type } as Manifest;
}

/**
 * Decides what to deploy, from the manifest when present and detection
 * otherwise.
 *
 * @throws with an actionable message when neither can answer.
 */
/** Reads a duration such as "30s" or "2m" into seconds. */
export function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;

  const match = /^(\d+)\s*(s|m)?$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Invalid duration '${value}'. Use a form like 30s or 2m.`);
  }

  const amount = Number(match[1]);
  return match[2] === "m" ? amount * 60 : amount;
}

export function resolveDeploySpec(files: Set<string>, manifestSource: string | null): DeploySpec {
  const manifest = manifestSource === null ? null : parseQuaiToml(manifestSource);
  const detected = manifest === null ? detectProjectType(files) : null;

  if (manifest === null && detected === null) {
    throw new Error(
      "Cannot tell what this directory holds. Add a quai.toml declaring its " +
        "type, or include an index.html for a static site.",
    );
  }

  const type = manifest?.type ?? detected!.type;
  // A detected function already knows its handler, so no manifest is needed.
  const start = manifest?.service?.start ?? detected?.handler;

  if (type !== "static" && !start) {
    throw new Error(
      "A " +
        type +
        " needs a start command. Add one to quai.toml:\n\n" +
        "  [service]\n  start = \"node server.js\"",
    );
  }

  return {
    type,
    runtime: manifest?.runtime ?? detected?.runtime,
    start,
    internalPort: manifest?.service?.internal_port,
    build: manifest?.build,
    limits: manifest?.limits,
    domains: manifest?.domains?.custom,
    env: manifest?.env,
    timeoutSeconds: parseDuration(manifest?.limits?.timeout ?? manifest?.timeout),
  };
}

