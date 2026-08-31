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
import { configPath, readConfig, writeConfig } from "./config";
import { localRunPlan } from "./dev";
import { renderQuaiToml } from "./init";
import { latestReleaseUrl, releaseAssetUrl, targetTriple } from "./release";
import { replaceRunningBinary, uninstallPlan } from "./self-update";
import { deployQuery } from "./deploy-query";
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

async function deploy(directory: string, production = false): Promise<void> {
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

  const target = production ? "production" : spec.type;
  console.log(`Deploying ${project} (${target}, ${files.length} files)...`);

  const query = deployQuery(spec, { production });

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

/** Lists every project on the instance, so it need not be known by name. */
async function listCommand(): Promise<void> {
  const config = await readConfig();
  if (config === null) fail("not logged in. Run 'quai login <user@host> <zone>' first.");

  const projects = JSON.parse(await admin("list", "")) as {
    name: string;
    type: string;
    run: { state: string };
    givenUp?: boolean;
  }[];

  if (projects.length === 0) {
    console.log("No projects on this instance yet.");
    return;
  }

  const width = Math.max(...projects.map((project) => project.name.length));
  for (const project of projects) {
    const state = project.givenUp ? "given up" : project.run.state;
    console.log(
      project.name.padEnd(width) +
        "  " + project.type.padEnd(8) +
        "  " + state.padEnd(9) +
        "  https://" + project.name + "." + config.zone,
    );
  }
}

/** Opens the project's URL, so it need not be retyped. */
async function openCommand(directory: string): Promise<void> {
  const config = await readConfig();
  if (config === null) fail("not logged in. Run 'quai login <user@host> <zone>' first.");

  const url = `https://${projectNameFromPath(resolve(directory))}.${config.zone}`;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";

  const proc = Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;

  // Printing it too means the command is still useful over SSH, where no
  // browser can be opened.
  console.log(url);
}

/** Writes a backup of the instance to a file. */
async function backupCommand(args: string[]): Promise<void> {
  const path = args.find((argument) => !argument.startsWith("-")) ?? "quai-backup.json";
  const backup = await admin("backup", "");

  await Bun.write(path, backup);

  const parsed = JSON.parse(backup) as { projects: { name: string }[] };
  console.log(`Wrote ${path} (${parsed.projects.length} project(s)).`);
}

/** Restores an instance from a backup file. */
async function restoreCommand(args: string[]): Promise<void> {
  const path = args.find((argument) => !argument.startsWith("-"));
  if (path === undefined) fail("usage: quai restore <backup.json>");

  const contents = await Bun.file(path).text().catch(() => null);
  if (contents === null) fail(`could not read ${path}`);

  const parsed = JSON.parse(contents) as { projects: { name: string }[]; takenAt: number };
  console.log(
    `Restoring ${parsed.projects.length} project(s) from ${new Date(parsed.takenAt).toISOString()}`,
  );

  const result = await admin("restore", "", JSON.parse(contents));
  console.log(result.trim());
  console.log("Redeploy each project to bring its content back.");
}

/** Shows what is actually enforced for this project. */
async function statusCommand(directory: string): Promise<void> {
  const project = projectNameFromPath(resolve(directory));
  const all = JSON.parse(await admin("status", project)) as Record<string, unknown>[];
  const found = all.find((entry) => entry.name === project);

  if (found === undefined) fail(`no project named ${project} on this instance`);
  console.log(JSON.stringify(found, null, 2));
}

/** Stamped at build time so 'quai update' can tell whether it is current. */
const VERSION = process.env.QUAI_BUILD_VERSION ?? "0.1.0-dev";

const REPOSITORY = process.env.QUAI_REPO ?? "atinseau/quai";

/** The tag of the newest published release. */
async function latestTag(): Promise<string> {
  const response = await fetch(latestReleaseUrl(REPOSITORY), {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) fail(`could not reach GitHub to check for updates (${response.status})`);

  const release = (await response.json()) as { tag_name?: string };
  if (!release.tag_name) fail("no published release found");
  return release.tag_name;
}

/**
 * Replaces this binary with the newest release.
 *
 * The new build is downloaded and checked before anything is moved, so a
 * failed update leaves a working quai behind rather than a broken one — which
 * matters more here than anywhere else, since a broken quai cannot repair
 * itself.
 */
async function updateCommand(args: string[]): Promise<void> {
  const requested = args.find((argument) => !argument.startsWith("-"));
  const tag = requested ?? (await latestTag());

  // Whether the tag was asked for or resolved, downloading what is already
  // installed only risks a failed swap for nothing.
  if (tag === `v${VERSION}` && !args.includes("--force")) {
    console.log(`quai ${VERSION} is already installed. Use --force to reinstall it.`);
    return;
  }

  const target = targetTriple(process.platform === "darwin" ? "Darwin" : "Linux", process.arch === "arm64" ? "arm64" : "x86_64");
  const current = process.execPath;
  const staged = current + ".new";

  console.log(`Updating quai ${VERSION} -> ${tag} (${target})`);

  const response = await fetch(releaseAssetUrl(REPOSITORY, tag, target));
  if (!response.ok) {
    fail(`could not download ${target} for ${tag} (${response.status})`);
  }

  await Bun.write(staged, await response.arrayBuffer());

  // Verify the download runs before it becomes the binary on the PATH.
  await chmodExecutable(staged);
  const probe = Bun.spawn([staged, "--version"], { stdout: "pipe", stderr: "pipe" });
  await probe.exited;
  if (probe.exitCode !== 0) {
    await Bun.file(staged).delete().catch(() => {});
    fail("the downloaded binary does not run; nothing was changed");
  }

  const backup = await replaceRunningBinary(current, staged);
  console.log(`Updated to ${tag}. The previous binary is at ${backup}.`);
}

async function chmodExecutable(path: string): Promise<void> {
  const { chmod } = await import("node:fs/promises");
  await chmod(path, 0o755);
}

/** Removes the CLI and its login configuration, and nothing else. */
async function uninstallCommand(args: string[]): Promise<void> {
  const { rm } = await import("node:fs/promises");
  const { dirname } = await import("node:path");

  const plan = uninstallPlan(process.execPath, dirname(configPath()));

  if (!args.includes("--yes") && !args.includes("-y")) {
    console.log("quai uninstall would remove:");
    console.log(`  ${plan.binary}`);
    console.log(`  ${plan.config}`);
    console.log("");
    console.log("Your projects and anything already deployed are untouched.");
    console.log("Run 'quai uninstall --yes' to go ahead.");
    return;
  }

  await rm(plan.config, { recursive: true, force: true });
  await rm(plan.binary + ".old", { force: true }).catch(() => {});
  await rm(plan.binary, { force: true });

  console.log("quai removed. Deployed projects keep running.");
}

/**
 * Runs the project locally, the way the server would.
 *
 * A function is served by the same host the supervisor uses, so a handler that
 * answers here answers there — the point being to find a mistake before a
 * deploy rather than after one.
 */
async function devCommand(args: string[]): Promise<void> {
  const flagIndex = args.findIndex((argument) => argument === "--port" || argument === "-p");
  const port = flagIndex === -1 ? 3000 : Number(args[flagIndex + 1] ?? 3000);
  const directory = args.find(
    (argument, index) => !argument.startsWith("-") && index !== flagIndex + 1,
  );
  const root = resolve(directory ?? process.cwd());

  let spec: DeploySpec;
  try {
    spec = resolveDeploySpec(new Set(await readdir(root)), await readManifest(root));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (spec.build?.command) await runBuild(root, spec.build.command);

  const plan = localRunPlan(spec, { root, port });

  if (plan.serveStatic !== null) {
    const directoryToServe = plan.serveStatic;
    Bun.serve({
      port,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const file = Bun.file(join(directoryToServe, path.endsWith("/") ? path + "index.html" : path));
        return (await file.exists())
          ? new Response(file)
          : new Response("Not found", { status: 404 });
      },
    });
    console.log(`Serving ${directoryToServe} on http://localhost:${port}`);
    return;
  }

  console.log(`Running ${spec.type} on http://localhost:${port} (ctrl-c to stop)`);

  const child = Bun.spawn(plan.command, {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    stdout: "inherit",
    stderr: "inherit",
  });

  // Ctrl-C should stop the project, not orphan it.
  process.on("SIGINT", () => {
    child.kill();
    process.exit(0);
  });

  await child.exited;
}

async function login(host: string, zone: string): Promise<void> {
  if (!host || !zone) fail("usage: quai login <user@host> <zone>");
  await writeConfig({ host, zone });
  console.log(`Logged in to ${host}, serving *.${zone}`);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case undefined:
  case "--prod":
  case "deploy": {
    const production = process.argv.includes("--prod");
    const directory = rest.find((argument) => !argument.startsWith("-")) ?? process.cwd();
    await deploy(directory, production);
    break;
  }
  case "dev":
    await devCommand(rest);
    break;
  case "init":
    await init(rest[0] ?? process.cwd());
    break;
  case "env":
    await envCommand(rest, process.cwd());
    break;
  case "list":
    await listCommand();
    break;
  case "open":
    await openCommand(rest[0] ?? process.cwd());
    break;
  case "backup":
    await backupCommand(rest);
    break;
  case "restore":
    await restoreCommand(rest);
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
  case "update":
    await updateCommand(rest);
    break;
  case "uninstall":
    await uninstallCommand(rest);
    break;
  case "--version":
  case "version":
    console.log(VERSION);
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
        "  quai --prod               deploy to the production domain",
        "  quai deploy [dir]         deploy a specific directory",
        "  quai dev [--port N]       run the project locally, as the server would",
        "  quai init [dir]           write a quai.toml for this project",
        "  quai env ls|add|rm|pull   manage environment variables",
        "  quai logs [-f]            show recent output, -f to follow",
        "  quai status               show the limits actually enforced",
        "  quai list                 list every project on the instance",
        "  quai open                 open this project in a browser",
        "  quai backup [file]        write a backup of the instance",
        "  quai restore <file>       restore an instance from a backup",
        "  quai rm                   delete the project and everything it owns",
        "",
        "  quai update [tag]         replace this binary with a newer release",
        "  quai uninstall            remove the CLI and its configuration",
        "  quai version              print the installed version",
        "  quai login <host> <zone>  point the CLI at an instance",
      ].join("\n"),
    );
    break;
  default:
    fail(`unknown command '${command}'. Try 'quai help'.`);
}

