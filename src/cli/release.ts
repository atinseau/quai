/**
 * Where releases live.
 *
 * Everything is addressed by tag, never by branch: installing from a branch
 * hands out whatever happens to be on main, which is not a release anyone
 * tested and cannot be reproduced later.
 */

const SYSTEMS: Record<string, string> = { Linux: "linux", Darwin: "darwin" };
const ARCHITECTURES: Record<string, string> = {
  x86_64: "x64",
  amd64: "x64",
  arm64: "arm64",
  aarch64: "arm64",
};

/** The asset name for a machine, as published by the release workflow. */
export function targetTriple(system: string, machine: string): string {
  const os = SYSTEMS[system];
  if (os === undefined) {
    throw new Error(
      `Unsupported system '${system}'. Build from source: bun build --compile src/cli/main.ts`,
    );
  }

  const arch = ARCHITECTURES[machine];
  if (arch === undefined) {
    throw new Error(`Unsupported architecture '${machine}'.`);
  }

  return `quai-${os}-${arch}`;
}

/** Overridable so the release flow can be exercised against a local server. */
const API_BASE = process.env.QUAI_API_URL ?? "https://api.github.com";
const DOWNLOAD_BASE = process.env.QUAI_BASE_URL ?? "https://github.com";

export function latestReleaseUrl(repository: string): string {
  return `${API_BASE}/repos/${repository}/releases/latest`;
}

export function releaseAssetUrl(repository: string, tag: string, asset: string): string {
  return `${DOWNLOAD_BASE}/${repository}/releases/download/${tag}/${asset}`;
}

/**
 * The installer for a given tag.
 *
 * Served from the tag rather than the branch, so re-running an install a year
 * from now does the same thing it did today.
 */
export function installerUrlForTag(repository: string, tag: string): string {
  return `${DOWNLOAD_BASE}/${repository}/releases/download/${tag}/install.sh`;
}
