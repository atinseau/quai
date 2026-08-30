/**
 * Health reporting.
 *
 * An operator must be able to tell, without shelling into the container,
 * whether Quai can keep its isolation promises and which runtimes it can host.
 */

import type { PreflightResult } from "./preflight";

export type RuntimeStatus = {
  name: string;
  /** Version string, or null when the runtime failed to answer. */
  version: string | null;
};

export type HealthInputs = {
  isolation: PreflightResult;
  runtimes: RuntimeStatus[];
};

export type HealthReport = {
  /**
   * "unhealthy" means an isolation guarantee is missing and Quai must not host
   * projects. "degraded" means isolation holds but some runtimes are absent,
   * which only narrows what can be deployed.
   */
  status: "healthy" | "degraded" | "unhealthy";
  isolation: {
    supported: boolean;
    failing: string[];
  };
  runtimes: RuntimeStatus[];
};

export function buildHealthReport(inputs: HealthInputs): HealthReport {
  const failing = inputs.isolation.failures.map((failure) => failure.requirement);
  const missingRuntimes = inputs.runtimes.filter((runtime) => runtime.version === null);

  const status = !inputs.isolation.supported
    ? "unhealthy"
    : missingRuntimes.length > 0
      ? "degraded"
      : "healthy";

  return {
    status,
    isolation: { supported: inputs.isolation.supported, failing },
    runtimes: inputs.runtimes,
  };
}

