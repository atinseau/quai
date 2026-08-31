#!/usr/bin/env bun
/**
 * SSH forced command for administrative actions.
 *
 * The same contract as the deploy command: whatever the client asks for, only
 * the listed actions can happen, and the project name is validated rather than
 * trusted. A deploy key never yields a shell.
 */

import { parseAdminCommand } from "./parse-command";

const SUPERVISOR = process.env.QUAI_SUPERVISOR ?? "http://127.0.0.1:8080";
const TOKEN = process.env.QUAI_DEPLOY_TOKEN ?? "";

function refuse(message: string): never {
  console.error("quai: " + message);
  process.exit(1);
}

const requested = process.env.SSH_ORIGINAL_COMMAND ?? process.argv.slice(2).join(" ");

let action: string;
let project: string;
try {
  ({ action, project } = parseAdminCommand(requested));
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}

const ENDPOINTS: Record<string, { path: string; method: string }> = {
  "env-get": { path: "/_quai/env", method: "GET" },
  "env-set": { path: "/_quai/env", method: "POST" },
  logs: { path: "/_quai/logs", method: "GET" },
  remove: { path: "/_quai/remove", method: "POST" },
  domains: { path: "/_quai/domains", method: "POST" },
  status: { path: "/_quai/status", method: "GET" },
  list: { path: "/_quai/status", method: "GET" },
  backup: { path: "/_quai/backup", method: "GET" },
  restore: { path: "/_quai/restore", method: "POST" },
};

const endpoint = ENDPOINTS[action]!;
const body = endpoint.method === "POST" ? await Bun.stdin.text() : undefined;

const response = await fetch(
  SUPERVISOR + endpoint.path + '?project=' + encodeURIComponent(project),
  {
    method: endpoint.method,
    headers: { "x-quai-token": TOKEN, "content-type": "application/json" },
    body: body && body.length > 0 ? body : undefined,
  },
);

const text = await response.text();
if (!response.ok) refuse(text || action + ' failed with status ' + response.status);

process.stdout.write(text);
