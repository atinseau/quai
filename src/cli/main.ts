#!/usr/bin/env bun
/**
 * The quai CLI.
 *
 * The everyday gesture is a bare "quai" from a project directory: no flags, no
 * project id, and no configuration file in the common case. The directory name
 * is the project name, which is what makes redeploying idempotent.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { collectFiles } from "./collect";
import { readConfig, writeConfig } from "./config";
import { renderQuaiToml } from "./init";
import { detectProjectType, resolveDeploySpec, type DeploySpec } from "./manifest";
import { projectNameFromPath } from "../supervisor/naming";
import { packTar } from "../supervisor/tar";

function fail(message: string): never {
  console.error("quai: " + message);
  process.exit(1);
}

async function readManifest(directory: string): Promise<string | null> {
  return readFile(join(directory, "quai.toml"), "utf8").catch(() => null);
}

/** Runs the build the manifest declares, on this machine. */
async function runBuild(directory: string, command: string): Promise<void> {
  console.log("Building: " + command);
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) fail("build failed, nothing was deployed");
}

async function deploy(directory: string): Promise<void> {
  const config = await readConfig();
  if (config === null) {
    fail("not logged in. Run 'quai login <user@host> <zone>' first.");
  }

  const root = resolve(directory);
  const project = projectNameFromPath(root);
  const manifest = await readManifest(root);

  let spec: DeploySpec;
  try {
    spec = resolveDeploySpec(new Set(await readdir(root)), manifest);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // The build runs here, on the developer's machine: no toolchain in the
  // container, and a broken build never reaches the server.
  if (spec.build?.command) await runBuild(root, spec.build.command);

  // Only the build output ships when one is declared, so sources and
  // dependencies stay behind.
  const source = spec.build?.output ? join(root, spec.build.output) : root;
  const files = await collectFiles(source).catch(() => []);

  if (files.length === 0) fail(`nothing to deploy in ${source}`);

  console.log(`Deploying ${project} (${spec.type}, ${files.length} files)...`);

  const query = new URLSearchParams({ type: spec.type });
  if (spec.runtime) query.set("runtime", spec.runtime);
  if (spec.start) query.set("start", spec.start);
  if (spec.internalPort) query.set("port", String(spec.internalPort));

  const archive = packTar(files);
  // The SSH key on the server is pinned to a forced command, so this
  // connection can only ever deploy: it never yields a shell.
  const proc = Bun.spawn(["ssh", config.host, "quai-deploy", project, query.toString()], {
    stdin: archive,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) fail(err.trim() || out.trim() || "deploy failed");
  console.log(out.trim());
}

async function init(directory: string): Promise<void> {
  const root = resolve(directory);
  const path = join(root, "quai.toml");

  if (await readFile(path, "utf8").then(() => true).catch(() => false)) {
    fail("quai.toml already exists here");
  }

  const files = new Set(await readdir(root));
  const detected = detectProjectType(files);

  const rendered = renderQuaiToml({
    name: projectNameFromPath(root),
    type: detected?.type ?? "static",
    runtime: detected?.runtime,
    start: detected?.runtime === "python" ? "python3 main.py" : "node server.js",
  });

  await Bun.write(path, rendered);
  console.log("Wrote quai.toml (" + (detected?.type ?? "static") + "). Edit it, then run 'quai'.");
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
  case "init":
    await init(rest[0] ?? process.cwd());
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
        "  quai init [dir]           write a quai.toml for this project",
        "  quai login <host> <zone>  point the CLI at an instance",
      ].join("\n"),
    );
    break;
  default:
    fail(`unknown command '${command}'. Try 'quai help'.`);
}

