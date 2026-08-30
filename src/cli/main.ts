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
import { formatEnvFile, isReservedEnvKey, parseEnvAssignment } from "./env";
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
  // Always sent, even empty: the server replaces the whole set, so an omitted
  // parameter would leave a removed domain still serving.
  query.set("domains", (spec.domains ?? []).join(","));

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


/**
 * Runs an administrative command against the instance.
 *
 * It travels the same authenticated SSH channel as a deploy, so there is no
 * second credential to manage and no port to expose.
 */
async function admin(
  action: string,
  project: string,
  body?: unknown,
): Promise<string> {
  const config = await readConfig();
  if (config === null) fail("not logged in. Run 'quai login <user@host> <zone>' first.");

  const proc = Bun.spawn(["ssh", config.host, "quai-admin", action, project], {
    stdin: body === undefined ? "ignore" : new TextEncoder().encode(JSON.stringify(body)),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) fail(err.trim() || out.trim() || action + " failed");
  return out;
}

async function envCommand(args: string[], directory: string): Promise<void> {
  const project = projectNameFromPath(resolve(directory));
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case undefined:
    case "ls": {
      const variables = JSON.parse(await admin("env-get", project)) as Record<string, string>;
      const keys = Object.keys(variables).sort();
      if (keys.length === 0) console.log("No variables set for " + project);
      for (const key of keys) console.log(key + "=" + variables[key]);
      break;
    }

    case "add": {
      const set: Record<string, string> = {};
      for (const assignment of rest) {
        const { key, value } = parseEnvAssignment(assignment);
        // Quai assigns these itself; overriding PORT would make the project
        // listen where the router is not looking.
        if (isReservedEnvKey(key)) fail(key + " is set by Quai and cannot be overridden");
        set[key] = value;
      }
      if (Object.keys(set).length === 0) fail("usage: quai env add KEY=value [KEY=value ...]");
      await admin("env-set", project, { set });
      console.log("Set " + Object.keys(set).join(", ") + ". Redeploy to apply.");
      break;
    }

    case "rm": {
      if (rest.length === 0) fail("usage: quai env rm KEY [KEY ...]");
      await admin("env-set", project, { unset: rest });
      console.log("Removed " + rest.join(", ") + ". Redeploy to apply.");
      break;
    }

    case "pull": {
      const variables = JSON.parse(await admin("env-get", project)) as Record<string, string>;
      const path = join(resolve(directory), ".env.local");
      await Bun.write(path, formatEnvFile(variables));
      console.log("Wrote " + path);
      break;
    }

    default:
      fail("unknown env command '" + subcommand + "'. Use ls, add, rm or pull.");
  }
}

async function logsCommand(args: string[]): Promise<void> {
  const follow = args.includes("-f") || args.includes("--follow");
  const directory = args.find((argument) => !argument.startsWith("-")) ?? process.cwd();
  const project = projectNameFromPath(resolve(directory));

  if (!follow) {
    process.stdout.write(await admin("logs", project));
    return;
  }

  // Polling rather than streaming: the buffer is bounded and a deploy is
  // diagnosed in seconds, so a second of latency costs nothing and keeps the
  // SSH channel simple.
  let seen = "";
  for (;;) {
    const current = await admin("logs", project);
    if (current.startsWith(seen)) {
      process.stdout.write(current.slice(seen.length));
    } else {
      // The buffer rolled past what we had; resynchronise rather than guess.
      process.stdout.write(current);
    }
    seen = current;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function removeCommand(directory: string): Promise<void> {
  const project = projectNameFromPath(resolve(directory));
  await admin("remove", project);
  console.log("Removed " + project + ": its account, home and quota are gone.");
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

/** Shows what is actually enforced for this project. */
async function statusCommand(directory: string): Promise<void> {
  const project = projectNameFromPath(resolve(directory));
  const all = JSON.parse(await admin("status", project)) as Record<string, unknown>[];
  const found = all.find((entry) => entry.name === project);

  if (found === undefined) fail(`no project named ${project} on this instance`);
  console.log(JSON.stringify(found, null, 2));
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
  case "env":
    await envCommand(rest, process.cwd());
    break;
  case "status":
    await statusCommand(rest[0] ?? process.cwd());
    break;
  case "logs":
    await logsCommand(rest);
    break;
  case "rm":
    await removeCommand(rest[0] ?? process.cwd());
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
        "  quai env ls|add|rm|pull   manage environment variables",
        "  quai logs [-f]            show recent output, -f to follow",
        "  quai status               show the limits actually enforced",
        "  quai rm                   delete the project and everything it owns",
        "  quai login <host> <zone>  point the CLI at an instance",
      ].join("\n"),
    );
    break;
  default:
    fail(`unknown command '${command}'. Try 'quai help'.`);
}

