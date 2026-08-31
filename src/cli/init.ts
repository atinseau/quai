/**
 * Generating a quai.toml.
 *
 * "quai init" exists so the format never has to be memorised. It writes only
 * what the project actually needs: a static site gets three lines, and the
 * sections that do not apply are simply absent.
 */

import type { ProjectType, Runtime } from "./manifest";

export type InitOptions = {
  name: string;
  type: ProjectType;
  runtime?: Runtime;
  start?: string;
  internalPort?: number;
  build?: { command?: string; output?: string };
};

/** TOML basic strings escape backslashes and quotes. */
function quote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Reduces a directory name to something usable as a project name.
 *
 * The generator must not emit a manifest its own parser refuses: a quote or an
 * uppercase letter in a folder name would otherwise produce a file that fails
 * on the next deploy.
 */
function safeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");

  return cleaned.length > 0 ? cleaned : "project";
}

export function renderQuaiToml(options: InitOptions): string {
  const lines = [
    "# Quai project manifest.",
    "# Everything here is optional: a plain static directory deploys without it.",
    "#",
    "# For completion and checking in your editor, point it at:",
    "#   https://raw.githubusercontent.com/atinseau/quai/main/schema/quai.schema.json",
    "",
    `name = ${quote(safeName(options.name))}`,
    `type = ${quote(options.type)}`,
  ];

  if (options.runtime) lines.push(`runtime = ${quote(options.runtime)}`);

  if (options.build?.command || options.build?.output) {
    lines.push("", "[build]");
    if (options.build.command) lines.push(`command = ${quote(options.build.command)}`);
    if (options.build.output) lines.push(`output = ${quote(options.build.output)}`);
  }

  if (options.type !== "static") {
    lines.push("", "[service]");
    // Declared rather than guessed: the process listens where it says it does.
    lines.push(`internal_port = ${options.internalPort ?? 8080}`);
    if (options.start) lines.push(`start = ${quote(options.start)}`);
  }

  lines.push(
    "",
    "# [limits]",
    '# memory = "256Mi"',
    '# cpu = "0.5"',
    "# pids = 64",
    '# disk = "1Gi"',
    "",
    "# [domains]",
    '# custom = ["www.example.com"]',
    "",
    "# [env]",
    '# NODE_ENV = "production"',
    "",
  );

  return lines.join("\n");
}
