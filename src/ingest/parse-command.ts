/**
 * Parsing of the command an SSH client requested.
 *
 * Kept pure and separate from the forced command script so the refusal rules
 * are testable: this is the boundary that guarantees a deploy key can never
 * become a shell.
 */

export type DeployRequest = {
  project: string;
  /** Deploy parameters the client encoded, or an empty string. */
  query: string;
};

/** Administrative actions a deploy key may perform. */
export const ADMIN_ACTIONS = [
  "env-get",
  "env-set",
  "logs",
  "remove",
  "domains",
  "status",
  "backup",
  "restore",
  "list",
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export type AdminRequest = { action: AdminAction; project: string };

/**
 * Parses an administrative request.
 *
 * The same strictness as a deploy: only the listed actions are possible, and
 * the project name is validated rather than trusted.
 */
export function parseAdminCommand(requested: string): AdminRequest {
  const parts = requested.trim().split(/\s+/).filter(Boolean);

  if (parts[0] !== "quai-admin") {
    throw new Error("This key may only deploy. No shell access is granted.");
  }

  const action = parts[1] ?? "";
  if (!ADMIN_ACTIONS.includes(action as AdminAction)) {
    throw new Error(`Unknown action '${action}'`);
  }

  // Instance-wide actions name no project; everything else must name a valid one.
  const instanceWide = action === "list" || action === "backup" || action === "restore";
  const project = parts[2] ?? "";

  if (!instanceWide && !/^[a-z0-9][a-z0-9-]*$/.test(project)) {
    throw new Error(`Invalid project name '${project}'`);
  }

  return { action: action as AdminAction, project };
}

export function parseForcedCommand(requested: string): DeployRequest {
  const parts = requested.trim().split(/\s+/).filter(Boolean);

  if (parts[0] !== "quai-deploy") {
    throw new Error("This key may only deploy. No shell access is granted.");
  }

  const project = parts[1] ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) {
    throw new Error(`Invalid project name '${project}'`);
  }

  // Anything past the project name is an opaque query string; it is parsed
  // by the supervisor, never executed here.
  return { project, query: parts[2] ?? "" };
}
