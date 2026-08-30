/**
 * Project naming and subdomain routing.
 *
 * The name is derived from the directory rather than generated, so that
 * redeploying the same folder updates the existing project instead of creating
 * a twin. That stability is what makes a bare "quai" work with no state on the
 * client side.
 */

/** DNS labels cannot exceed 63 characters. */
const MAX_LABEL_LENGTH = 63;

/**
 * Derives a project name from a directory path.
 *
 * The result must be a valid DNS label, since it becomes a subdomain.
 * @throws when the directory name contains nothing usable.
 */
export function projectNameFromPath(directory: string): string {
  const segments = directory.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? "";

  const name = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/-+$/g, "");

  if (name.length === 0) {
    throw new Error(
      `Cannot derive a project name from "${directory}". ` +
        "Pass an explicit name in quai.toml, or rename the directory to " +
        "something containing letters or digits.",
    );
  }

  return name;
}

/** The hostname a project is served on. */
export function subdomainOf(project: string, zone: string): string {
  return `${project}.${zone}`;
}

/**
 * Resolves an incoming Host header to a project name.
 *
 * Returns null when the host does not name a project in this zone: the bare
 * zone, a nested subdomain, or an unrelated domain that merely ends with the
 * same characters.
 */
export function projectFor(host: string, zone: string): string | null {
  const hostname = host.toLowerCase().split(":")[0] ?? "";
  const suffix = "." + zone.toLowerCase();

  if (!hostname.endsWith(suffix)) return null;

  const label = hostname.slice(0, -suffix.length);
  // A project lives at exactly one label below the zone.
  if (label.length === 0 || label.includes(".")) return null;

  return label;
}

