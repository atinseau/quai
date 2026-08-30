/**
 * Environment variables.
 *
 * Managed from the command line so there is no detour through a web interface,
 * and pullable into a local file so production can be reproduced on the
 * developer's machine.
 */

/**
 * Names Quai assigns itself.
 *
 * Letting a project override PORT would make it listen where the router is not
 * looking; overriding HOME or the function host's variables would break the
 * process in ways that look like the developer's fault.
 */
const RESERVED = new Set(["PORT", "HOME", "USER", "PATH", "QUAI_HANDLER", "QUAI_TIMEOUT_MS"]);

export function isReservedEnvKey(key: string): boolean {
  return RESERVED.has(key.toUpperCase());
}

export type EnvAssignment = { key: string; value: string };

/**
 * Parses a KEY=value argument.
 *
 * The split is on the first equals only: connection strings and tokens
 * routinely contain more.
 */
export function parseEnvAssignment(assignment: string): EnvAssignment {
  const separator = assignment.indexOf("=");
  if (separator === -1) {
    throw new Error(`Expected KEY=value, got '${assignment}'`);
  }

  const key = assignment.slice(0, separator).trim();
  const value = assignment.slice(separator + 1);

  if (key.length === 0) {
    throw new Error("An environment variable needs a name");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(
      `'${key}' is not a valid environment variable name. Use letters, digits ` +
        "and underscores, starting with a letter or underscore.",
    );
  }

  return { key, value };
}

/** True when a value needs quoting to survive a shell-style env file. */
function needsQuoting(value: string): boolean {
  return value === "" ? false : /[\s"'\\$`]/.test(value);
}

/**
 * Renders variables as a .env file.
 *
 * Values are quoted and escaped rather than written raw: a newline in a value
 * would otherwise forge a second assignment on the following line.
 */
export function formatEnvFile(variables: Record<string, string>): string {
  return Object.keys(variables)
    .sort()
    .map((key) => {
      const value = variables[key] ?? "";
      const rendered = needsQuoting(value)
        ? '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"'
        : value;
      return `${key}=${rendered}`;
    })
    .map((line) => line + "\n")
    .join("");
}

