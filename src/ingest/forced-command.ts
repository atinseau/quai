#!/usr/bin/env bun
/**
 * SSH forced command.
 *
 * Every deploy key in authorized_keys is pinned to this script with
 * command="...",no-pty,no-port-forwarding. A deploy credential therefore never
 * yields a shell: whatever the client asks for, this is what runs.
 *
 * It reads the archive from stdin and hands it to the supervisor.
 */

import { parseForcedCommand } from "./parse-command";

const SUPERVISOR = process.env.QUAI_SUPERVISOR ?? "http://127.0.0.1:8080";
const TOKEN = process.env.QUAI_DEPLOY_TOKEN ?? "";

function refuse(message: string): never {
  console.error("quai: " + message);
  process.exit(1);
}

// SSH_ORIGINAL_COMMAND is what the client asked for. We never execute it; it is
// only parsed for the project name, and anything unexpected is refused.
const requested = process.env.SSH_ORIGINAL_COMMAND ?? process.argv.slice(2).join(" ");

let project: string;
try {
  ({ project } = parseForcedCommand(requested));
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}

const archive = new Uint8Array(await Bun.stdin.arrayBuffer());
if (archive.length === 0) {
  refuse("no archive received on stdin");
}

const response = await fetch(
  `${SUPERVISOR}/_quai/deploy?project=${encodeURIComponent(project)}`,
  {
    method: "POST",
    headers: { "x-quai-token": TOKEN, "content-type": "application/x-tar" },
    body: archive,
  },
);

const payload = (await response.json()) as { url?: string; files?: number; error?: string };

if (!response.ok) {
  refuse(payload.error ?? `deploy failed with status ${response.status}`);
}

console.log(`Deployed ${payload.files} file(s)`);
console.log(payload.url);

