import { describe, expect, test } from "bun:test";
import { decideRestart, type RestartHistory } from "./restart-policy";

const history = (overrides: Partial<RestartHistory> = {}): RestartHistory => ({
  failures: 0,
  lastStartedAt: 0,
  lastFailedAt: 0,
  lastUptimeMs: 0,
  ...overrides,
});

describe("deciding whether to restart", () => {
  test("a first crash is retried immediately", () => {
    const decision = decideRestart(history({ failures: 0 }), 1000);
    expect(decision).toMatchObject({ action: "restart" });
  });

  test("a second crash waits before retrying", () => {
    const decision = decideRestart(history({ failures: 1, lastFailedAt: 1000 }), 1000);
    expect(decision).toMatchObject({ action: "wait" });
  });

  test("the wait grows with each failure", () => {
    const first = decideRestart(history({ failures: 1, lastFailedAt: 0 }), 0);
    const later = decideRestart(history({ failures: 3, lastFailedAt: 0 }), 0);
    expect(first.action).toBe("wait");
    expect(later.action).toBe("wait");
    expect((later as { delayMs: number }).delayMs).toBeGreaterThan(
      (first as { delayMs: number }).delayMs,
    );
  });

  test("the wait is capped, so a project is not parked for hours", () => {
    // Just below the give-up threshold, where the backoff is at its longest.
    const decision = decideRestart(history({ failures: 9, lastFailedAt: 0 }), 0);
    expect(decision.action).toBe("wait");
    expect((decision as { delayMs: number }).delayMs).toBeLessThanOrEqual(60_000);
  });

  test("once the wait has elapsed the project is restarted", () => {
    const decision = decideRestart(history({ failures: 1, lastFailedAt: 0 }), 60_000);
    expect(decision).toMatchObject({ action: "restart" });
  });

  test("a project that keeps failing is given up on", () => {
    // Restarting forever would burn the machine on something definitively
    // broken, and hide the failure from the operator.
    const decision = decideRestart(history({ failures: 10, lastFailedAt: 0 }), 3_600_000);
    expect(decision).toMatchObject({ action: "give-up" });
  });

  test("giving up says why, so an operator is not left guessing", () => {
    const decision = decideRestart(history({ failures: 10, lastFailedAt: 0 }), 3_600_000);
    expect((decision as { reason: string }).reason).toContain("10");
  });

  test("a project that ran long enough starts from a clean slate", () => {
    // A crash after a week of uptime is an incident, not a broken project;
    // counting it against old failures would retire it far too early.
    const decision = decideRestart(
      history({ failures: 4, lastUptimeMs: 600_000, lastFailedAt: 600_000 }),
      600_000,
    );
    expect(decision).toMatchObject({ action: "restart" });
  });

  test("a crash just after starting still counts as a failure", () => {
    const decision = decideRestart(
      history({ failures: 4, lastUptimeMs: 1_000, lastFailedAt: 2_000 }),
      2_000,
    );
    expect(decision.action).not.toBe("restart");
  });

  test("waiting out a backoff does not read as a healthy run", () => {
    // Wall-clock time since the last start keeps growing while a project waits,
    // so recomputing uptime would clear the count and restart a broken project
    // forever. The uptime is recorded when it died, not derived later.
    const decision = decideRestart(
      history({ failures: 5, lastUptimeMs: 200, lastFailedAt: 0 }),
      3_600_000,
    );
    expect(decision.action).toBe("restart");
    const later = decideRestart(
      history({ failures: 10, lastUptimeMs: 200, lastFailedAt: 0 }),
      3_600_000,
    );
    expect(later.action).toBe("give-up");
  });

  test("the failure count is what a deploy resets", () => {
    expect(decideRestart(history({ failures: 0 }), 0).action).toBe("restart");
  });
});
