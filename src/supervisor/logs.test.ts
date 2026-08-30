import { describe, expect, test } from "bun:test";
import { LogBuffer } from "./logs";

describe("capturing project output", () => {
  test("what a project writes is readable back", () => {
    const buffer = new LogBuffer(10);
    buffer.append("starting up\n");
    expect(buffer.read()).toBe("starting up\n");
  });

  test("successive writes accumulate", () => {
    const buffer = new LogBuffer(10);
    buffer.append("one\n");
    buffer.append("two\n");
    expect(buffer.read()).toBe("one\ntwo\n");
  });

  test("only the most recent lines are kept", () => {
    // A long-running project would otherwise grow its log without bound and
    // exhaust the supervisor's memory.
    const buffer = new LogBuffer(2);
    buffer.append("one\ntwo\nthree\n");
    expect(buffer.read()).toBe("two\nthree\n");
  });

  test("a partial line is held until it completes", () => {
    const buffer = new LogBuffer(10);
    buffer.append("half");
    buffer.append(" a line\n");
    expect(buffer.read()).toBe("half a line\n");
  });

  test("a write spanning several lines is split correctly", () => {
    const buffer = new LogBuffer(10);
    buffer.append("a\nb\nc\n");
    expect(buffer.read().split("\n").filter(Boolean)).toEqual(["a", "b", "c"]);
  });

  test("an empty buffer reads as empty", () => {
    expect(new LogBuffer(10).read()).toBe("");
  });

  test("the limit counts lines, not writes", () => {
    const buffer = new LogBuffer(3);
    for (let i = 0; i < 10; i++) buffer.append(`line ${i}\n`);
    expect(buffer.read().split("\n").filter(Boolean)).toHaveLength(3);
  });
});

