import { describe, expect, test } from "bun:test";
import { formatEnvFile, parseEnvAssignment, isReservedEnvKey } from "./env";

describe("setting a variable", () => {
  test("a simple assignment is split on the first equals", () => {
    expect(parseEnvAssignment("NODE_ENV=production")).toEqual({
      key: "NODE_ENV",
      value: "production",
    });
  });

  test("a value containing equals signs is kept whole", () => {
    // Connection strings and tokens routinely contain '='.
    expect(parseEnvAssignment("DSN=postgres://u:p@h/db?x=1")).toEqual({
      key: "DSN",
      value: "postgres://u:p@h/db?x=1",
    });
  });

  test("surrounding whitespace is trimmed from the key", () => {
    expect(parseEnvAssignment("  KEY =value").key).toBe("KEY");
  });

  test("the value keeps its own spaces", () => {
    expect(parseEnvAssignment("GREETING=hello world").value).toBe("hello world");
  });

  test("an assignment with no equals is refused", () => {
    expect(() => parseEnvAssignment("JUST_A_KEY")).toThrow(/KEY=value/);
  });

  test("an empty key is refused", () => {
    expect(() => parseEnvAssignment("=orphan")).toThrow();
  });

  test("a key with a space is refused, since no shell could export it", () => {
    expect(() => parseEnvAssignment("MY KEY=value")).toThrow(/name/i);
  });

  test("an empty value is allowed, since it differs from unset", () => {
    expect(parseEnvAssignment("EMPTY=")).toEqual({ key: "EMPTY", value: "" });
  });
});

describe("reserved names", () => {
  test("PORT is reserved, since Quai assigns it", () => {
    // Letting a project override PORT would make it listen where the router
    // is not looking.
    expect(isReservedEnvKey("PORT")).toBe(true);
  });

  test("HOME is reserved", () => {
    expect(isReservedEnvKey("HOME")).toBe(true);
  });

  test("the function host's own variables are reserved", () => {
    expect(isReservedEnvKey("QUAI_HANDLER")).toBe(true);
  });

  test("an ordinary name is not reserved", () => {
    expect(isReservedEnvKey("DATABASE_URL")).toBe(false);
  });
});

describe("pulling variables into a local file", () => {
  test("each variable becomes a line", () => {
    expect(formatEnvFile({ A: "1", B: "2" })).toBe("A=1\nB=2\n");
  });

  test("keys are sorted, so the file does not churn between pulls", () => {
    expect(formatEnvFile({ B: "2", A: "1" })).toBe("A=1\nB=2\n");
  });

  test("a value with spaces is quoted", () => {
    expect(formatEnvFile({ MSG: "hello world" })).toBe('MSG="hello world"\n');
  });

  test("a value with a quote is escaped rather than breaking the file", () => {
    expect(formatEnvFile({ Q: 'say "hi"' })).toBe('Q="say \\"hi\\""\n');
  });

  test("a newline in a value cannot forge a second assignment", () => {
    // Otherwise a value could inject an unrelated variable on the next line.
    const rendered = formatEnvFile({ X: "a\nEVIL=1" });
    expect(rendered.split("\n").filter((l) => l.includes("EVIL=1") && !l.startsWith("X"))).toEqual(
      [],
    );
  });

  test("an empty set yields an empty file", () => {
    expect(formatEnvFile({})).toBe("");
  });
});

