import { describe, expect, test } from "bun:test";
import { packTar, unpackTar } from "./tar";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const entry = (name: string, body: string) => ({ name, contents: encoder.encode(body) });

describe("tar round trip", () => {
  test("a single file survives packing and unpacking", () => {
    const [out] = unpackTar(packTar([entry("index.html", "<h1>hi</h1>")]));
    expect(out!.name).toBe("index.html");
    expect(decoder.decode(out!.contents)).toBe("<h1>hi</h1>");
  });

  test("several files keep their order and content", () => {
    const out = unpackTar(packTar([entry("a.txt", "one"), entry("b.txt", "two")]));
    expect(out.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
    expect(decoder.decode(out[1]!.contents)).toBe("two");
  });

  test("nested paths are preserved", () => {
    const [out] = unpackTar(packTar([entry("assets/css/app.css", "body{}")]));
    expect(out!.name).toBe("assets/css/app.css");
  });

  test("an empty file survives the round trip", () => {
    const [out] = unpackTar(packTar([entry("empty.txt", "")]));
    expect(out!.contents.length).toBe(0);
  });

  test("a file larger than one block is not truncated", () => {
    // Sizes that are not a multiple of 512 are where padding bugs surface.
    const body = "x".repeat(1337);
    const [out] = unpackTar(packTar([entry("big.txt", body)]));
    expect(decoder.decode(out!.contents)).toBe(body);
  });

  test("binary content is preserved byte for byte", () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 26, 127]);
    const [out] = unpackTar(packTar([{ name: "bin", contents: bytes }]));
    expect(Array.from(out!.contents)).toEqual(Array.from(bytes));
  });

  test("an empty archive unpacks to nothing", () => {
    expect(unpackTar(packTar([]))).toEqual([]);
  });

  test("the archive ends with the two zero blocks tar requires", () => {
    const archive = packTar([entry("a", "b")]);
    expect(archive.slice(-1024).every((byte) => byte === 0)).toBe(true);
  });

  test("truncated input yields what is readable instead of throwing", () => {
    const archive = packTar([entry("a.txt", "hello")]);
    expect(() => unpackTar(archive.slice(0, 300))).not.toThrow();
  });
});

