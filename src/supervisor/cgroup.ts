/**
 * Per-project cgroup limits.
 *
 * A project that eats too much memory, CPU or processes is contained on its
 * own while its neighbours stay reachable. Without this, one runaway takes the
 * whole instance down.
 *
 * The prototype established two constraints that are easy to get wrong: the
 * container must run with cgroupns=host or memory.max is written without any
 * error and enforces nothing, and the supervisor must step into a leaf cgroup
 * before enabling controllers, per the "no internal process" rule.
 */

export type Limits = {
  /** Memory ceiling, e.g. "256Mi". */
  memory: string;
  /** CPU share as a fraction of one core, e.g. "0.5". */
  cpu: string;
  /** Maximum number of processes, which is what stops a fork bomb. */
  pids: number;
};

/**
 * Defaults sized so an unconfigured project cannot take the host down, while
 * still fitting an ordinary small service.
 */
export const DEFAULT_LIMITS: Limits = {
  memory: "256Mi",
  cpu: "0.5",
  pids: 64,
};

/** cgroup v2 expresses CPU as "quota period" in microseconds. */
const CPU_PERIOD = 100_000;

const SIZE_UNITS: Record<string, number> = {
  "": 1,
  K: 1_000,
  M: 1_000_000,
  G: 1_000_000_000,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
};

/**
 * Parses a size such as "256Mi" into bytes.
 *
 * @throws on anything malformed: defaulting would grant a limit the operator
 * never chose, which is worse than refusing to start.
 */
export function parseSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([KMG]i?)?$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Invalid size '${value}'. Use a form like 256Mi or 1Gi.`);
  }

  const bytes = Number(match[1]) * (SIZE_UNITS[match[2] ?? ""] ?? 1);
  if (bytes <= 0) {
    throw new Error(`Invalid size '${value}': a limit must be greater than zero.`);
  }

  return Math.floor(bytes);
}

/**
 * Parses a CPU share into the "quota period" pair cgroup v2 expects.
 *
 * @throws on anything malformed, for the same reason as parseSize.
 */
export function parseCpu(value: string): string {
  const share = Number(value.trim());
  if (!Number.isFinite(share) || share <= 0) {
    throw new Error(`Invalid cpu share '${value}'. Use a form like 0.5 or 2.`);
  }

  return `${Math.round(share * CPU_PERIOD)} ${CPU_PERIOD}`;
}

export type CgroupWrite = { file: string; value: string };

export class ProjectCgroup {
  constructor(
    readonly containerCgroup: string,
    readonly project: string,
  ) {}

  get path(): string {
    return `${this.containerCgroup}/quai-${this.project}`;
  }

  /**
   * Where the supervisor moves itself before delegating controllers.
   *
   * A cgroup cannot both hold processes and enable controllers for its
   * children, so staying at the root would make delegation fail outright.
   */
  get supervisorLeaf(): string {
    return `${this.containerCgroup}/quai-supervisor`;
  }

  delegationWrite(): CgroupWrite {
    return { file: "cgroup.subtree_control", value: "+memory +cpu +pids" };
  }

  limitWrites(limits: Limits): CgroupWrite[] {
    return [
      { file: "memory.max", value: String(parseSize(limits.memory)) },
      // Without this a project could evade its memory cap by swapping.
      { file: "memory.swap.max", value: "0" },
      { file: "cpu.max", value: parseCpu(limits.cpu) },
      { file: "pids.max", value: String(limits.pids) },
    ];
  }

  attachWrite(pid: number): CgroupWrite {
    return { file: "cgroup.procs", value: String(pid) };
  }
}

