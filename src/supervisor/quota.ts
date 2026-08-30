/**
 * Per-project disk quotas.
 *
 * The last way one tenant could still hurt every other: filling the shared
 * volume. XFS project quotas close it, enforced by the kernel rather than by
 * Quai watching a directory grow.
 *
 * The prototype could not validate this — its homes were on overlayfs, which
 * carries no quotas at all — so the preflight refuses to start unless the
 * homes sit on XFS mounted with prjquota.
 */

import { parseSize } from "./cgroup";

/** Modest by default, so an unconfigured project cannot fill the volume. */
export const DEFAULT_DISK_QUOTA = "1Gi";

export type QuotaReport = { usedBytes: number; limitBytes: number };

/** xfs_quota reports in KiB unless told otherwise. */
const REPORT_UNIT = 1024;

export class ProjectQuota {
  constructor(
    private readonly mountPoint: string,
    readonly project: string,
    /** The project's uid, reused as its quota project id. */
    readonly projectId: number,
    /**
     * Where the project's content actually lives.
     *
     * A static project keeps its files under sites/, a service under its own
     * home in projects/. Assuming one shape silently left the other on quota
     * project 0, where no limit applies at all.
     */
    private readonly contentPath: string,
  ) {}

  /** The directory the quota applies to. Public so callers can create it. */
  get directory(): string {
    return this.contentPath;
  }

  /**
   * Commands that assign the directory to a quota project and cap it.
   *
   * The directory must exist first: xfs_quota marks an existing tree, and
   * marking a missing path silently leaves the content on project 0, where no
   * limit applies.
   */
  applyCommands(limit: string): string[][] {
    const bytes = parseSize(limit);

    return [
      // -s marks the directory tree as belonging to this project id.
      ["xfs_quota", "-x", "-c", `project -s -p ${this.directory} ${this.projectId}`, this.mountPoint],
      ["xfs_quota", "-x", "-c", `limit -p bhard=${bytes} ${this.projectId}`, this.mountPoint],
    ];
  }

  /** Command that reports current usage against the limit. */
  reportCommand(): string[] {
    return ["xfs_quota", "-x", "-c", "report -p -N -b", this.mountPoint];
  }

  /**
   * Commands that release the quota when a project is deleted.
   *
   * Without this the limit lingers against a project id that no longer exists,
   * and the accounting slowly fills with dead entries.
   */
  releaseCommands(): string[][] {
    return [
      ["xfs_quota", "-x", "-c", `limit -p bhard=0 ${this.projectId}`, this.mountPoint],
    ];
  }
}

/**
 * Reads one line of an xfs_quota report.
 *
 * Returns null rather than a guess when the line is not a project entry: a
 * wrong number here would misreport how full a project is.
 */
export function parseQuotaReport(line: string): QuotaReport | null {
  const match = /^#(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line.trim());
  if (match === null) return null;

  return {
    usedBytes: Number(match[2]) * REPORT_UNIT,
    limitBytes: Number(match[4]) * REPORT_UNIT,
  };
}

