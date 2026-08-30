/**
 * Syscall confinement.
 *
 * The last isolation layer: everything else keeps projects apart from each
 * other, this one reduces what any of them can ask of the shared kernel. It is
 * what makes hosting untrusted third-party code defensible rather than merely
 * tidy.
 *
 * The policy denies rather than allow-lists. An allow-list is stronger on
 * paper but breaks the four runtimes on every kernel upgrade; a deny-list
 * keeps ordinary programs working while closing the paths that lead out of a
 * container.
 */

/** Syscalls no deployed project has a legitimate reason to make. */
// Names must exist in kafel, the policy language nsjail compiles. Three that
// seemed obvious are absent on aarch64 and make the whole policy fail to
// compile: umount2, iopl and ioperm. The first is covered by umount; the other
// two are x86-only port I/O that does not exist on this architecture.
export const DENIED_SYSCALLS = [
  // Loading kernel code is the shortest path from a container to the host.
  "init_module",
  "finit_module",
  "delete_module",
  // Host-wide actions.
  "reboot",
  "kexec_load",
  "kexec_file_load",
  "settimeofday",
  "clock_settime",
  "adjtimex",
  // Kernel keyring, a repeated source of container escapes.
  "add_key",
  "request_key",
  "keyctl",
  // Inspecting or altering another process.
  "ptrace",
  "process_vm_readv",
  "process_vm_writev",
  // Reshaping the filesystem view, which would reach outside the project tree.
  "mount",
  "umount",
  "pivot_root",
  "swapon",
  "swapoff",
  // Namespace escapes.
  "setns",
  // Kernel debugging surface.
  "bpf",
  "perf_event_open",
] as const;

export class SeccompProfile {
  /**
   * Renders the policy in kafel, the language nsjail reads.
   *
   * Denied calls return an error rather than killing the process: a kill looks
   * like a crash, while an error is something the runtime can report and an
   * operator can diagnose.
   */
  policy(): string {
    const denied = DENIED_SYSCALLS.join(",\n  ");
    return [
      "// Quai syscall policy.",
      "// Ordinary programs run unhindered; the calls below lead out of the",
      "// container and are refused with EPERM.",
      "POLICY quai {",
      `  ERRNO(1) {\n  ${denied}\n  }`,
      "}",
      "USE quai DEFAULT ALLOW",
    ].join("\n");
  }
}

export type JailOptions = {
  policyPath: string;
  command: string[];
  /** The project's home. nsjail starts in / unless told otherwise. */
  cwd?: string;
  /** Variables to hand the child. nsjail clears the environment otherwise. */
  env?: Record<string, string>;
};

/** Directories searched for a bare command name. */
const SEARCH_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];

/**
 * Resolves a bare command name to an absolute path.
 *
 * nsjail execs directly and does not consult PATH, so a command given by name
 * alone fails with ENOENT no matter how the environment is set.
 */
export function resolveExecutable(
  name: string,
  exists: (path: string) => boolean,
): string {
  if (name.includes("/")) return name;

  for (const directory of SEARCH_PATH) {
    const candidate = directory + "/" + name;
    if (exists(candidate)) return candidate;
  }

  return name;
}

/**
 * Wraps a command so it runs under the policy.
 *
 * nsjail is told not to create its own user or network namespaces: the runner
 * already drops privileges and provides the network stack, and letting nsjail
 * redo either would fight that setup.
 */
export function buildJailArgs(options: JailOptions): string[] {
  return [
    "nsjail",
    "--quiet",
    "--mode",
    "o", // run once, in the foreground, so the runner still owns the process
    "--seccomp_policy",
    options.policyPath,
    // nsjail starts the child in / regardless of the parent's cwd, so a
    // relative script path would resolve against the filesystem root.
    ...(options.cwd ? ["--cwd", options.cwd] : []),
    // nsjail hands the child an empty environment unless each variable is
    // passed explicitly, so HOME and PORT would arrive undefined.
    ...Object.entries(options.env ?? {}).flatMap(([key, value]) => [
      "--env",
      key + "=" + value,
    ]),
    "--disable_clone_newnet",
    "--disable_clone_newuser",
    "--disable_clone_newns",
    "--disable_clone_newpid",
    "--disable_clone_newipc",
    "--disable_clone_newuts",
    "--disable_clone_newcgroup",
    "--disable_rlimits",
    "--",
    ...options.command,
  ];
}

