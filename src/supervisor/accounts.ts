/**
 * UNIX account management.
 *
 * One account per project is the file-isolation boundary the prototype
 * validated: a project can neither read, list nor write another's home.
 */

import { readFile } from "node:fs/promises";

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

/**
 * Creates the account for a project with an exact uid.
 *
 * The uid must match the record: files on the quota volume are owned by uid,
 * so a fresh one would leave the project unable to read its own deploy.
 */
export async function createAccount(project: string, uid: number): Promise<void> {
  const account = accountNameFor(project);

  const proc = Bun.spawn(
    [
      "useradd",
      "--create-home",
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

  // 0750 is what keeps a neighbour from listing or reading the home.
  const chmod = Bun.spawn(["chmod", "0750", `/home/${account}`], { stderr: "pipe" });
  await chmod.exited;
}

