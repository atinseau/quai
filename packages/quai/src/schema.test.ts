import { describe, expect, test } from "bun:test";
import schema from "../../../schema/quai.schema.json";

describe("the editor schema matches the manifest Quai accepts", () => {
  const properties = schema.properties as Record<string, unknown>;

  test("every top-level key of the format is described", () => {
    // A key missing here shows as an error in the editor even though Quai
    // accepts it, which is worse than no schema at all.
    expect(Object.keys(properties).toSorted()).toEqual([
      "build",
      "domains",
      "env",
      "limits",
      "name",
      "runtime",
      "service",
      "type",
    ]);
  });

  test("the project types are the three Quai supports", () => {
    expect((properties.type as { enum: string[] }).enum).toEqual(["static", "service", "function"]);
  });

  test("the runtimes are the three that have hosts", () => {
    expect((properties.runtime as { enum: string[] }).enum).toEqual(["node", "bun", "python"]);
  });

  test("only type is required, so a minimal manifest validates", () => {
    expect(schema.required).toEqual(["type"]);
  });

  test("unknown keys are rejected, so a typo is caught in the editor", () => {
    expect(schema.additionalProperties).toBe(false);
  });

  test("the limits mirror what the supervisor enforces", () => {
    const limits = (properties.limits as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(limits).toSorted()).toEqual(["cpu", "disk", "memory", "pids", "timeout"]);
  });

  test("a size pattern accepts the forms the parser accepts", () => {
    const pattern = new RegExp(
      (properties.limits as { properties: { memory: { pattern: string } } }).properties.memory
        .pattern,
    );
    for (const value of ["256Mi", "1Gi", "512", "2G"]) {
      expect(pattern.test(value)).toBe(true);
    }
    expect(pattern.test("plenty")).toBe(false);
  });

  test("a project name pattern matches what the supervisor allows", () => {
    const pattern = new RegExp((properties.name as { pattern: string }).pattern);
    expect(pattern.test("my-site")).toBe(true);
    expect(pattern.test("My_Site")).toBe(false);
  });
});
