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

export function renderQuaiToml(options: InitOptions): string {
  const lines = [
    "# Quai project manifest.",
    "# Everything here is optional: a plain static directory deploys without it.",
    "",
    `name = ${quote(options.name)}`,
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

