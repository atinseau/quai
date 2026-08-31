/**
 * Project logs that survive a restart.
 *
 * The in-memory buffer serves recent reads, but it vanishes when the
 * supervisor restarts — which makes a crash during the night impossible to
 * diagnose. This keeps the same output on the state volume.
 *
 * Bounded on purpose: an unbounded log would eventually take the disk every
 * other project depends on.
 */

import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Enough to diagnose a failed start without threatening the volume. */
const DEFAULT_MAX_BYTES = 256 * 1024;

/** Writes are batched: a chatty project should not cost one syscall per line. */
const FLUSH_AFTER_BYTES = 8 * 1024;

/**
 * A quiet project must not keep its output in memory indefinitely.
 *
 * Batching alone meant a service logging a line at startup never reached the
 * threshold, so nothing was ever written and the log did not survive a restart
 * — exactly the case the file exists for.
 */
const FLUSH_AFTER_MS = 2_000;

export type LogOptions = { maxBytes?: number };

export class PersistentLog {
  private pending = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxBytes: number;

  constructor(
    private readonly directory: string,
    private readonly project: string,
    options: LogOptions = {},
  ) {
    // The project name arrives from a deploy request, so it is untrusted.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) {
      throw new Error(`Invalid project name '${project}' for a log file`);
    }
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private get path(): string {
    return join(this.directory, this.project + ".log");
  }

  async append(chunk: string): Promise<void> {
    this.pending += chunk;

    if (this.pending.length >= FLUSH_AFTER_BYTES) {
      await this.flush();
      return;
    }

    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush().catch(() => {});
      }, FLUSH_AFTER_MS);
      // A pending write must not hold the supervisor open at shutdown.
      this.flushTimer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;

    const chunk = this.pending;
    this.pending = "";

    await mkdir(this.directory, { recursive: true });
    await appendFile(this.path, chunk).catch(async () => {
      // A corrupted or unreadable file must not silence a project's output.
      await writeFile(this.path, chunk);
    });

    await this.rotateIfNeeded();
  }

  /**
   * Drops the oldest half when the file grows past its limit.
   *
   * Keeping the recent end matters: the lines explaining a crash are the last
   * ones written, not the first.
   */
  private async rotateIfNeeded(): Promise<void> {
    const size = await stat(this.path)
      .then((info) => info.size)
      .catch(() => 0);
    if (size <= this.maxBytes) return;

    const contents = await readFile(this.path, "utf8").catch(() => "");
    const kept = contents.slice(-Math.floor(this.maxBytes / 2));
    // Start at a line boundary so the first entry is not a fragment.
    const trimmed = kept.slice(kept.indexOf("\n") + 1);
    await writeFile(this.path, trimmed);
  }

  async read(): Promise<string> {
    await this.flush();
    return readFile(this.path, "utf8").catch(() => "");
  }

  async remove(): Promise<void> {
    this.pending = "";
    await rm(this.path, { force: true });
  }
}
