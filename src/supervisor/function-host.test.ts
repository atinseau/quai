import { describe, expect, test } from "bun:test";
import { functionHostFor, DEFAULT_FUNCTION_TIMEOUT } from "./function-host";

describe("hosting a function", () => {
  test("a Node handler is wrapped by a Node host", () => {
    expect(functionHostFor("node", "api.js", 30).command[0]).toContain("node");
  });

  test("a Bun handler is wrapped by a Bun host", () => {
    expect(functionHostFor("bun", "api.ts", 30).command[0]).toContain("bun");
  });

  test("a Python handler is wrapped by a Python host", () => {
    expect(functionHostFor("python", "api.py", 30).command[0]).toContain("python");
  });

  test("the handler path is passed to the host", () => {
    // Through the environment rather than argv, so a handler name can never be
    // read as a flag by the interpreter.
    expect(functionHostFor("node", "handlers/api.js", 30).env.QUAI_HANDLER).toBe(
      "handlers/api.js",
    );
  });

  test("a handler named like a flag cannot reach the interpreter as one", () => {
    const host = functionHostFor("node", "--eval", 30);
    expect(host.command).not.toContain("--eval");
  });

  test("the timeout is passed to the host", () => {
    expect(functionHostFor("node", "api.js", 45).env.QUAI_TIMEOUT_MS).toBe("45000");
  });

  test("the default timeout is applied when none is declared", () => {
    expect(DEFAULT_FUNCTION_TIMEOUT).toBe("30s");
  });

  test("an unsupported runtime is refused rather than silently skipped", () => {
    expect(() => functionHostFor("ruby" as never, "api.rb", 30)).toThrow(/runtime/i);
  });

  test("every supported runtime has a host", () => {
    for (const runtime of ["node", "bun", "python"] as const) {
      expect(() => functionHostFor(runtime, "api", 30)).not.toThrow();
    }
  });
});

