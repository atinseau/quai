/**
 * Parsing of the command an SSH client requested.
 *
 * Kept pure and separate from the forced command script so the refusal rules
 * are testable: this is the boundary that guarantees a deploy key can never
 * become a shell.
 */

export type DeployRequest = { project: string };

export function parseForcedCommand(requested: string): DeployRequest {
  const parts = requested.trim().split(/\s+/).filter(Boolean);

  if (parts[0] !== "quai-deploy") {
    throw new Error("This key may only deploy. No shell access is granted.");
  }

  const project = parts[1] ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) {
    throw new Error(`Invalid project name '${project}'`);
  }

  return { project };
}

