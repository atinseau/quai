import { describe, expect, test } from "bun:test";
import { accountNameFor, homeFor } from "./accounts";

describe("where project homes live", () => {
  test("a home sits on the persistent volume, not inside the container", () => {
    // /home disappears when the container is recreated. A project whose code
    // vanished came back as an empty account that started and died at once.
    expect(homeFor("api").startsWith("/home/")).toBe(false);
  });

  test("homes are under the volume that carries the disk quota", () => {
    expect(homeFor("api")).toContain("/srv/quai/homes");
  });

  test("two projects get separate homes", () => {
    expect(homeFor("alpha")).not.toBe(homeFor("beta"));
  });

  test("the account name is distinct from the project name", () => {
    // So a project cannot be confused with an unrelated system account.
    expect(accountNameFor("api")).toBe("quai-api");
  });

  test("the home path is derived from the project, so a restart finds it again", () => {
    expect(homeFor("api")).toBe(homeFor("api"));
  });
});

