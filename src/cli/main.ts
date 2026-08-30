#!/usr/bin/env bun
/**
 * The quai CLI.
 *
 * The everyday gesture is a bare "quai" from a project directory: no flags, no
 * project id, no config file in the common case. The directory name is the
 * project name, which is what makes redeploying idempotent.
 */

import { basename, resolve } from "node:path";
import { collectFiles } from "./collect";
import { readConfig, writeConfig } from "./config";
import { projectNameFromPath } from "../supervisor/naming";
import { packTar } from "../supervisor/tar";

function fail(message: string): never {
  console.error("quai: " + message);
  process.exit(1);
}

async function deploy(directory: string): Promise<void> {
  const config = await readConfig();
  if (config === null) {
    fail("not logged in. Run 'quai login <user@host> <zone>' first.");
  }

  const root = resolve(directory);
  const project = projectNameFromPath(root);
  const files = await collectFiles(root);

  if (files.length === 0) {
    fail(`nothing to deploy in ${root}`);
  }

  console.log(`Deploying ${project} (${files.length} files)...`);

  const archive = packTar(files);
  // The SSH key on the server is restricted to a forced command, so this
  // connection can only ever deploy: it never yields a shell.
  const proc = Bun.spawn(["ssh", config.host, "quai-deploy", project], {
    stdin: archive,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) {
    fail(err.trim() || out.trim() || "deploy failed");
  }

  console.log(out.trim());
}

async function login(host: string, zone: string): Promise<void> {
  if (!host || !zone) fail("usage: quai login <user@host> <zone>");
  await writeConfig({ host, zone });
  console.log(`Logged in to ${host}, serving *.${zone}`);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case undefined:
  case "deploy":
    await deploy(rest[0] ?? process.cwd());
    break;
  case "login":
    await login(rest[0] ?? "", rest[1] ?? "");
    break;
  case "--help":
  case "help":
    console.log(
      [
        "Usage:",
        "  quai                      deploy the current directory",
        "  quai deploy [dir]         deploy a specific directory",
        "  quai login <host> <zone>  point the CLI at an instance",
      ].join("\n"),
    );
    break;
  default:
    fail(`unknown command '${command}'. Try 'quai help'.`);
}

