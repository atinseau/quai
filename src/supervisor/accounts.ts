/**
 * UNIX account management.
 *
 * One account per project is the file-isolation boundary the prototype
 * validated: a project can neither read, list nor write another's home.
 *
 * Homes live on the persistent volume rather than in /home. Anything inside
 * the container disappears when it is recreated, and a project whose code
 * vanished would come back as an empty account that starts and immediately
 * dies. The volume is also where the disk quota applies.
 */

import { readFile } from "node:fs/promises";

/** Root of the project homes, on the quota-bearing volume. */
const HOMES_ROOT = process.env.QUAI_HOMES ?? "/srv/quai/homes";

/** Reads the accounts Quai manages, by project name. */
export async function readAccounts(): Promise<Map<string, number>> {
  const accounts = new Map<string, number>();

  try {
    const passwd = await readFile("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const [name, , uid] = line.split(":");
      if (name?.startsWith("quai-") && uid !== undefined) {
        accounts.set(name.slice("quai-".length), Number(uid));
      }
    }
  } catch {
    // No passwd file readable; treat as no accounts.
  }

  return accounts;
}

/** The system user backing a project. */
export function accountNameFor(project: string): string {
  return "quai-" + project;
}

/** The home directory a project's files live in, on the persistent volume. */
export function homeFor(project: string): string {
  return HOMES_ROOT + "/projects/" + project;
}

/**
 * Creates the account for a project with an exact uid.
 *
 * The uid must match the record: files on the quota volume are owned by uid,
 * so a fresh one would leave the project unable to read its own deploy.
 */
export async function createAccount(project: string, uid: number): Promise<void> {
  const account = accountNameFor(project);
  const home = homeFor(project);

  const proc = Bun.spawn(
    [
      "useradd",
      "--home-dir",
      home,
      // Never --create-home: on a restart the home already holds the project's
      // code, and recreating it would silently replace a working deploy with
      // an empty directory.
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      "--uid",
      String(uid),
      account,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error(`useradd failed for ${account}: ${stderr.trim()}`);
  }
}

/** Ensures a project's home exists and belongs to it, with 0750 permissions. */
export async function prepareHome(project: string, uid: number): Promise<void> {
  const home = homeFor(project);
  const { mkdir, chmod } = await import("node:fs/promises");

  await mkdir(home, { recursive: true });
  // 0750 is what keeps a neighbour from listing or reading the home.
  await chmod(home, 0o750);

  const chown = Bun.spawn(["chown", "-R", `${uid}:${uid}`, home], { stderr: "pipe" });
  await chown.exited;
}

/** Removes a project's account and home. */
export async function removeAccount(project: string): Promise<void> {
  const proc = Bun.spawn(["userdel", accountNameFor(project)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  const { rm } = await import("node:fs/promises");
  await rm(homeFor(project), { recursive: true, force: true }).catch(() => {});
}

