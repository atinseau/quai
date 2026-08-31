/**
 * Project log capture.
 *
 * Keeps the most recent output of each project so a failed deploy can be
 * diagnosed without shelling into the container. Bounded on purpose: a
 * long-running project would otherwise grow its log until the supervisor runs
 * out of memory.
 */

export class LogBuffer {
  private lines: string[] = [];
  /** Output arrives in chunks, not lines; a partial line waits here. */
  private pending = "";

  constructor(private readonly maxLines: number) {}

  append(chunk: string): void {
    const combined = this.pending + chunk;
    const parts = combined.split("\n");
    // The last element is whatever follows the final newline, so it is either
    // an incomplete line or empty.
    this.pending = parts.pop() ?? "";

    this.lines.push(...parts);
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(-this.maxLines);
    }
  }

  read(): string {
    return this.lines.length === 0 ? "" : this.lines.join("\n") + "\n";
  }
}
