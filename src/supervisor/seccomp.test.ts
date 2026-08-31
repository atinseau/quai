import { describe, expect, test } from "bun:test";
import { SeccompProfile, DENIED_SYSCALLS, buildJailArgs, resolveExecutable } from "./seccomp";

const profile = new SeccompProfile();

describe("the seccomp policy", () => {
  test("kernel module loading is denied", () => {
    // The shortest path from a container to the host kernel.
    expect(DENIED_SYSCALLS).toContain("init_module");
  });

  test("rebooting the host is denied", () => {
    expect(DENIED_SYSCALLS).toContain("reboot");
  });

  test("changing the system clock is denied", () => {
    expect(DENIED_SYSCALLS).toContain("settimeofday");
  });

  test("kernel keyring access is denied", () => {
    // add_key has been a repeated source of container escapes.
    expect(DENIED_SYSCALLS).toContain("add_key");
  });

  test("ptrace is denied, so one project cannot inspect another's process", () => {
    expect(DENIED_SYSCALLS).toContain("ptrace");
  });

  test("mounting is denied, so a project cannot reach outside its own tree", () => {
    expect(DENIED_SYSCALLS).toContain("mount");
  });

  test("only syscall names kafel knows are used", () => {
    // A single unknown name makes the whole policy fail to compile, leaving
    // every service dead. umount2, iopl and ioperm are absent on aarch64.
    for (const absent of ["umount2", "iopl", "ioperm"]) {
      expect(DENIED_SYSCALLS).not.toContain(absent);
    }
  });

  test("the policy denies rather than allow-lists", () => {
    // An allow-list would break the four runtimes on every kernel upgrade;
    // a deny-list keeps ordinary programs working while closing known escapes.
    expect(profile.policy()).toContain("DEFAULT ALLOW");
  });

  test("denied syscalls return an error rather than killing the process", () => {
    // A killed process looks like a crash; an error is something the runtime
    // can report, which is what an operator needs to diagnose.
    expect(profile.policy()).toContain("ERRNO");
  });

  test("every denied syscall appears in the generated policy", () => {
    const policy = profile.policy();
    for (const syscall of DENIED_SYSCALLS) {
      expect(policy).toContain(syscall);
    }
  });

  test("the policy is readable, so an operator can audit what is enforced", () => {
    expect(profile.policy().split("\n").length).toBeGreaterThan(1);
  });
});

describe("wrapping a command", () => {
  const args = buildJailArgs({
    policyPath: "/etc/quai/seccomp.policy",
    command: ["node", "server.js"],
  });

  test("the process runs under nsjail", () => {
    expect(args[0]).toBe("nsjail");
  });

  test("the seccomp policy is applied", () => {
    expect(args.join(" ")).toContain("/etc/quai/seccomp.policy");
  });

  test("the policy flag is the one nsjail actually accepts", () => {
    // nsjail names it --seccomp_policy; --seccomp_policy_file is rejected
    // outright, which left every service failing to start.
    expect(args).toContain("--seccomp_policy");
  });

  test("the command is passed through last", () => {
    expect(args.slice(-2)).toEqual(["node", "server.js"]);
  });

  test("the command is separated by --, so its flags are not read by nsjail", () => {
    const wrapped = buildJailArgs({
      policyPath: "/etc/quai/seccomp.policy",
      command: ["node", "--max-old-space-size=64", "server.js"],
    });
    expect(wrapped.indexOf("--")).toBeLessThan(wrapped.indexOf("--max-old-space-size=64"));
  });

  test("nsjail does not re-isolate what the runner already handles", () => {
    // Uid, cgroups and the network namespace are the runner's job; letting
    // nsjail redo them would fight the existing setup.
    const line = args.join(" ");
    expect(line).toContain("--disable_clone_newnet");
    expect(line).toContain("--disable_clone_newuser");
  });
});

describe("resolving the executable", () => {
  const exists = (path: string) => path === "/usr/bin/node" || path === "/usr/local/bin/bun";

  test("a bare name is resolved to an absolute path", () => {
    // nsjail execs directly and never consults PATH, so a bare name fails with
    // ENOENT however the environment is set.
    expect(resolveExecutable("node", exists)).toBe("/usr/bin/node");
  });

  test("a name found earlier in the search path wins", () => {
    expect(resolveExecutable("bun", exists)).toBe("/usr/local/bin/bun");
  });

  test("a path that is already absolute is left alone", () => {
    expect(resolveExecutable("/opt/custom/bin/app", exists)).toBe("/opt/custom/bin/app");
  });

  test("a relative path is left alone, since it is meant to be relative to cwd", () => {
    expect(resolveExecutable("./server", exists)).toBe("./server");
  });

  test("an unknown name is passed through, so the error names what was asked for", () => {
    expect(resolveExecutable("nowhere", exists)).toBe("nowhere");
  });
});

describe("working directory", () => {
  test("the project's home is passed to nsjail", () => {
    // nsjail starts the child in / whatever the parent's cwd, so "node
    // server.js" resolved against the filesystem root and failed.
    const args = buildJailArgs({
      policyPath: "/etc/quai/seccomp.policy",
      command: ["node", "server.js"],
      cwd: "/home/quai-api",
    });
    expect(args.join(" ")).toContain("--cwd /home/quai-api");
  });

  test("the cwd flag precedes the command separator", () => {
    const args = buildJailArgs({
      policyPath: "/p",
      command: ["node", "server.js"],
      cwd: "/home/quai-api",
    });
    expect(args.indexOf("--cwd")).toBeLessThan(args.indexOf("--"));
  });

  test("omitting the cwd leaves nsjail's default alone", () => {
    const args = buildJailArgs({ policyPath: "/p", command: ["node", "s.js"] });
    expect(args).not.toContain("--cwd");
  });
});

describe("environment inside the jail", () => {
  const args = buildJailArgs({
    policyPath: "/p",
    command: ["node", "server.js"],
    env: { HOME: "/home/quai-api", PORT: "8080" },
  });

  test("each variable is passed explicitly", () => {
    // nsjail hands the child an empty environment otherwise, so HOME arrived
    // undefined and the project could not write its own files.
    expect(args.join(" ")).toContain("--env HOME=/home/quai-api");
  });

  test("PORT reaches the process", () => {
    expect(args.join(" ")).toContain("--env PORT=8080");
  });

  test("variables precede the command separator", () => {
    expect(args.lastIndexOf("--env")).toBeLessThan(args.indexOf("--"));
  });

  test("an empty environment adds no flags", () => {
    const bare = buildJailArgs({ policyPath: "/p", command: ["node", "s.js"] });
    expect(bare).not.toContain("--env");
  });
});
