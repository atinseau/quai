import { describe, expect, test } from "bun:test";
import { latestReleaseUrl, releaseAssetUrl, installerUrlForTag, targetTriple } from "./release";

describe("choosing the build for a machine", () => {
  test("linux on intel", () => {
    expect(targetTriple("Linux", "x86_64")).toBe("quai-linux-x64");
  });

  test("linux on arm", () => {
    expect(targetTriple("Linux", "aarch64")).toBe("quai-linux-arm64");
  });

  test("macos on apple silicon", () => {
    expect(targetTriple("Darwin", "arm64")).toBe("quai-darwin-arm64");
  });

  test("macos on intel", () => {
    expect(targetTriple("Darwin", "x86_64")).toBe("quai-darwin-x64");
  });

  test("an unsupported system is refused rather than guessed", () => {
    expect(() => targetTriple("Windows_NT", "x86_64")).toThrow(/unsupported/i);
  });

  test("an unsupported architecture is refused", () => {
    expect(() => targetTriple("Linux", "riscv64")).toThrow(/unsupported/i);
  });
});

describe("release urls", () => {
  test("an asset is fetched from its tag, never from a branch", () => {
    // Installing from a branch would hand out whatever happens to be on main,
    // which is not a release anyone tested.
    const url = releaseAssetUrl("atinseau/quai", "v1.2.3", "quai-linux-x64");
    expect(url).toContain("/releases/download/v1.2.3/");
    expect(url).not.toContain("/main/");
  });

  test("the installer itself is served from a release, not a branch", () => {
    // A branch would hand out whatever was merged last, which is not a
    // release anyone tested.
    const url = installerUrlForTag("atinseau/quai", "v1.2.3");
    expect(url).toContain("/releases/download/v1.2.3/install.sh");
    expect(url).not.toContain("/main/");
    expect(url).not.toContain("raw.githubusercontent");
  });

  test("the latest release is resolved through the api, not a branch", () => {
    expect(latestReleaseUrl("atinseau/quai")).toBe(
      "https://api.github.com/repos/atinseau/quai/releases/latest",
    );
  });

  test("a repository with a dash is handled", () => {
    expect(releaseAssetUrl("me/my-tool", "v1", "quai-linux-x64")).toContain("me/my-tool");
  });
});

