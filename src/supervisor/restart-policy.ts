/**
 * When to restart a crashed project.
 *
 * A service that dies stays dead without this: the supervisor notices and
 * reports it, but nobody brings it back, so a passing out-of-memory kill
 * retires a project until someone redeploys by hand.
 *
 * The decision is pure and separate from running anything, so every rule below
 * is testable without starting a process.
 */

/** Backoff doubles from here. */
const FIRST_DELAY_MS = 1_000;
/** Long enough to stop hammering, short enough that recovery is not a wait. */
const MAX_DELAY_MS = 60_000;
/** After this many failures a project is treated as broken, not unlucky. */
const MAX_FAILURES = 10;
/**
 * Uptime that clears the record.
 *
 * A crash after a long healthy run is an incident, not a broken project;
 * counting it against old failures would retire it far too early.
 */
const HEALTHY_UPTIME_MS = 60_000;

export type RestartHistory = {
  failures: number;
  /** When the project last started, used to tell an incident from a loop. */
  lastStartedAt: number;
  lastFailedAt: number;
  /**
   * How long the project ran before dying, measured when it died.
   *
   * Recorded rather than recomputed: a project waiting out its backoff keeps
   * accumulating wall-clock time since it last started, which would eventually
   * read as a healthy run and clear the failure count. A broken project would
   * then restart forever.
   */
  lastUptimeMs: number;
};

export type RestartDecision =
  | { action: "restart" }
  | { action: "wait"; delayMs: number }
  | { action: "give-up"; reason: string };

function delayFor(failures: number): number {
  return Math.min(FIRST_DELAY_MS * 2 ** (failures - 1), MAX_DELAY_MS);
}

/**
 * Decides what to do with a project that has just stopped.
 *
 * @param now current time, injected so the rules can be tested without waiting.
 */
export function decideRestart(history: RestartHistory, now: number): RestartDecision {
  // A project that ran long enough before dying starts from a clean slate.
  const effectiveFailures = history.lastUptimeMs >= HEALTHY_UPTIME_MS ? 0 : history.failures;

  if (effectiveFailures >= MAX_FAILURES) {
    return {
      action: "give-up",
      reason:
        `stopped after ${effectiveFailures} failures in a row. ` +
        "Fix the project and redeploy to start it again.",
    };
  }

  if (effectiveFailures === 0) return { action: "restart" };

  const delay = delayFor(effectiveFailures);
  const waited = now - history.lastFailedAt;

  return waited >= delay ? { action: "restart" } : { action: "wait", delayMs: delay - waited };
}

