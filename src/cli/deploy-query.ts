/**
 * Building the deploy request.
 *
 * Everything the manifest declares has to reach the supervisor, or a project
 * asking for 512Mi silently runs on the default and the quai.toml becomes
 * decorative. Kept apart from the CLI plumbing so the contract is testable on
 * its own.
 */

import type { DeploySpec } from "./manifest";

export type DeployOptions = { production?: boolean };

export function deployQuery(spec: DeploySpec, options: DeployOptions = {}): URLSearchParams {
  const query = new URLSearchParams({ type: spec.type });

  if (spec.runtime) query.set("runtime", spec.runtime);
  if (spec.start) query.set("start", spec.start);
  if (spec.internalPort) query.set("port", String(spec.internalPort));
  if (spec.timeoutSeconds) query.set("timeout", String(spec.timeoutSeconds));

  // Absent limits are left out so the server's defaults apply, rather than
  // being pinned to whatever the client happened to think they were.
  if (spec.limits?.memory) query.set("memory", spec.limits.memory);
  if (spec.limits?.cpu) query.set("cpu", spec.limits.cpu);
  if (spec.limits?.pids) query.set("pids", String(spec.limits.pids));
  if (spec.limits?.disk) query.set("disk", spec.limits.disk);

  if (spec.env && Object.keys(spec.env).length > 0) {
    query.set("env", JSON.stringify(spec.env));
  }

  // Always sent, even empty: the server replaces the whole set, so an omitted
  // parameter would leave a retired domain still serving.
  query.set("domains", (spec.domains ?? []).join(","));

  if (options.production) query.set("prod", "1");

  return query;
}
