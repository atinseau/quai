import { describe, expect, test } from "bun:test";
import { ProjectCgroup, parseSize, parseCpu, DEFAULT_LIMITS } from "./cgroup";

describe("size parsing", () => {
  test("a plain byte count passes through", () => {
    expect(parseSize("1024")).toBe(1024);
  });

  test("mebibytes are expanded", () => {
    expect(parseSize("256Mi")).toBe(256 * 1024 * 1024);
  });

  test("gibibytes are expanded", () => {
    expect(parseSize("2Gi")).toBe(2 * 1024 * 1024 * 1024);
  });

  test("a decimal suffix is not confused with a binary one", () => {
    // 1M is a million bytes, 1Mi is 1048576. Silently conflating them would
    // hand a project 5% more memory than it asked for.
    expect(parseSize("1M")).toBe(1_000_000);
    expect(parseSize("1Mi")).toBe(1_048_576);
  });

  test("a malformed size is refused rather than defaulted", () => {
    // Defaulting would grant a limit the operator never chose.
    expect(() => parseSize("plenty")).toThrow(/size/i);
  });

  test("a negative size is refused", () => {
    expect(() => parseSize("-1Mi")).toThrow();
  });

  test("zero is refused, since it would kill the project instantly", () => {
    expect(() => parseSize("0")).toThrow();
  });
});

describe("cpu parsing", () => {
  test("a fraction of a core becomes a quota over a period", () => {
    expect(parseCpu("0.5")).toBe("50000 100000");
  });

  test("a whole core is expressed as the full period", () => {
    expect(parseCpu("1")).toBe("100000 100000");
  });

  test("more than one core is allowed", () => {
    expect(parseCpu("2.5")).toBe("250000 100000");
  });

  test("a malformed cpu share is refused", () => {
    expect(() => parseCpu("lots")).toThrow(/cpu/i);
  });

  test("zero cpu is refused, since the project could never run", () => {
    expect(() => parseCpu("0")).toThrow();
  });
});

describe("cgroup writes", () => {
  const cgroup = new ProjectCgroup("/sys/fs/cgroup/docker/abc", "api");

  test("the project gets a cgroup of its own", () => {
    expect(cgroup.path).toBe("/sys/fs/cgroup/docker/abc/quai-api");
  });

  test("memory, cpu and pids limits are all written", () => {
    const writes = cgroup.limitWrites({ memory: "256Mi", cpu: "0.5", pids: 64 });
    const files = writes.map((w) => w.file);
    expect(files).toContain("memory.max");
    expect(files).toContain("cpu.max");
    expect(files).toContain("pids.max");
  });

  test("swap is disabled, so a memory cap cannot be evaded by swapping", () => {
    const writes = cgroup.limitWrites(DEFAULT_LIMITS);
    expect(writes.find((w) => w.file === "memory.swap.max")?.value).toBe("0");
  });

  test("the memory limit is written in bytes", () => {
    const writes = cgroup.limitWrites({ ...DEFAULT_LIMITS, memory: "64Mi" });
    expect(writes.find((w) => w.file === "memory.max")?.value).toBe("67108864");
  });

  test("defaults are modest, so an unconfigured project cannot take the host", () => {
    expect(parseSize(DEFAULT_LIMITS.memory)).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(DEFAULT_LIMITS.pids).toBeLessThanOrEqual(256);
  });

  test("a process is placed in the cgroup by writing its pid", () => {
    expect(cgroup.attachWrite(4242)).toEqual({ file: "cgroup.procs", value: "4242" });
  });

  test("the supervisor steps into a leaf before delegating", () => {
    // A cgroup cannot both hold processes and delegate controllers to its
    // children: the "no internal process" rule the prototype hit.
    expect(cgroup.supervisorLeaf).toBe("/sys/fs/cgroup/docker/abc/quai-supervisor");
  });

  test("delegation enables exactly the controllers the limits need", () => {
    expect(cgroup.delegationWrite().value).toBe("+memory +cpu +pids");
  });
});


describe("cgroup path stability", () => {
  test("the project cgroup is a sibling of the supervisor leaf, not a child", () => {
    // Nesting under the leaf would put projects inside the cgroup holding the
    // supervisor, where delegation cannot reach them.
    const cgroup = new ProjectCgroup("/sys/fs/cgroup/docker/abc", "api");
    expect(cgroup.path.startsWith(cgroup.supervisorLeaf)).toBe(false);
  });

  test("both live directly under the container cgroup", () => {
    const cgroup = new ProjectCgroup("/sys/fs/cgroup/docker/abc", "api");
    expect(cgroup.path).toBe("/sys/fs/cgroup/docker/abc/quai-api");
    expect(cgroup.supervisorLeaf).toBe("/sys/fs/cgroup/docker/abc/quai-supervisor");
  });

  test("the container cgroup is exposed, so delegation targets the real parent", () => {
    // Deriving the parent by appending ".." to the project path broke once the
    // supervisor had moved: the base must be carried explicitly.
    const cgroup = new ProjectCgroup("/sys/fs/cgroup/docker/abc", "api");
    expect(cgroup.containerCgroup).toBe("/sys/fs/cgroup/docker/abc");
  });

  test("two projects get sibling cgroups", () => {
    const alpha = new ProjectCgroup("/sys/fs/cgroup/docker/abc", "alpha");
    const beta = new ProjectCgroup("/sys/fs/cgroup/docker/abc", "beta");
    expect(alpha.path).not.toBe(beta.path);
    expect(alpha.containerCgroup).toBe(beta.containerCgroup);
  });
});

