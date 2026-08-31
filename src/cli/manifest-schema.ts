/**
 * The shape of a quai.toml, enforced at runtime.
 *
 * A manifest is hand-written and arrives from outside the program, so a type
 * assertion proves nothing: before this, everything but `type` was cast
 * through unchecked and a misspelled key deployed with the setting quietly
 * missing. The schema turns that into an error naming the key.
 */

import { z } from "zod";

/** Sizes as the supervisor parses them: 256Mi, 1Gi, 512. */
const SIZE = /^\d+(\.\d+)?\s*(K|M|G|Ki|Mi|Gi)?$/;
/** Durations as the supervisor parses them: 30s, 2m, 45. */
const DURATION = /^\d+\s*(s|m)?$/;
/** A project name becomes a subdomain, so it has to be a valid DNS label. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;

const size = (field: string) =>
  z.string().regex(SIZE, `${field} must be a size such as "256Mi" or "1Gi"`);

export const manifestSchema = z
  .object({
    name: z
      .string()
      .max(63, "name is too long for a hostname label (63 characters)")
      .regex(PROJECT_NAME, 'name must be lowercase letters, digits and hyphens, e.g. "my-site"')
      .optional(),

    type: z.enum(["static", "service", "function"], {
      message: 'type must be one of: "static", "service", "function"',
    }),

    runtime: z
      .enum(["node", "bun", "python"], {
        message: 'runtime must be one of: "node", "bun", "python"',
      })
      .optional(),

    build: z
      .object({
        command: z.string().optional(),
        output: z.string().optional(),
      })
      // Unknown keys are named rather than dropped: a typo that silently does
      // nothing is the hardest kind of mistake to find.
      .strict()
      .optional(),

    service: z
      .object({
        internal_port: z
          .number()
          .int("internal_port must be a whole number")
          .min(1, "internal_port must be between 1 and 65535")
          .max(65535, "internal_port must be between 1 and 65535")
          .optional(),
        start: z.string().optional(),
      })
      .strict()
      .optional(),

    limits: z
      .object({
        memory: size("memory").optional(),
        cpu: z
          .string()
          .regex(/^\d+(\.\d+)?$/, 'cpu must be a number of cores, e.g. "0.5" or "2"')
          .optional(),
        pids: z.number().int().min(1, "pids must be at least 1").optional(),
        disk: size("disk").optional(),
        timeout: z
          .string()
          .regex(DURATION, 'timeout must be a duration such as "30s" or "2m"')
          .optional(),
      })
      .strict()
      .optional(),

    domains: z
      .object({
        custom: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),

    env: z
      .record(
        z.string(),
        z.string("environment values must be strings; quote numbers and booleans"),
      )
      .optional(),

    /** Accepted at the top level for a function, alongside limits.timeout. */
    timeout: z.string().regex(DURATION).optional(),
  })
  .strict();

export type ValidatedManifest = z.infer<typeof manifestSchema>;

/**
 * Renders validation failures as something a developer can act on.
 *
 * Every problem is listed, not just the first: fixing them one deploy at a
 * time is the slowest possible loop.
 */
export function formatManifestErrors(error: z.ZodError): string {
  const lines = ["quai.toml is not valid:", ""];

  for (const issue of error.issues) {
    const path = issue.path.join(".");

    if (issue.code === "unrecognized_keys") {
      const unknown = (issue as { keys: string[] }).keys;
      for (const key of unknown) {
        const where = path.length > 0 ? `${path}.${key}` : key;
        lines.push(`  ${where} is not a setting Quai knows about`);
      }
      continue;
    }

    lines.push(path.length > 0 ? `  ${path}: ${issue.message}` : `  ${issue.message}`);
  }

  lines.push("", "See https://github.com/atinseau/quai#quaitoml for the full format.");
  return lines.join("\n");
}
