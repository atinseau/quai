import { describe, expect, test } from "bun:test";
import { decodeCapabilities, findMountFor, parseCgroupPath } from "./parsers";

describe("mount table", () => {
  const mounts = [
    "overlay / overlay rw,relatime,lowerdir=/a:/b 0 0",
    "proc /proc proc rw,nosuid,nodev,noexec 0 0",
    "cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime 0 0",
    "/dev/sdb /srv/quai xfs rw,relatime,attr2,inode64,prjquota 0 0",
  ].join("\n");

  test("finds the mount for an exact mount point", () => {
    expect(findMountFor(mounts, "/srv/quai").type).toBe("xfs");
  });

  test("a path inside a mount resolves to that mount", () => {
    // QUAI_HOMES normally sits inside the volume rather than being the volume
    // itself, so an exact match alone would wrongly report no quotas.
    const mount = findMountFor(mounts, "/srv/quai/homes");
    expect(mount.type).toBe("xfs");
    expect(mount.options).toContain("prjquota");
  });

  test("the most specific mount wins over a shorter ancestor", () => {
    const nested = mounts + "\n/dev/sdc /srv/quai/homes ext4 rw,relatime 0 0";
    expect(findMountFor(nested, "/srv/quai/homes/alpha").type).toBe("ext4");
  });

  test("a path under no mount but the root falls back to the root mount", () => {
    expect(findMountFor(mounts, "/var/tmp").type).toBe("overlay");
  });

  test("a sibling directory sharing a name prefix is not a match", () => {
    // "/srv/quai-backup" must not match the "/srv/quai" mount.
    const withSibling = mounts + "\n/dev/sdd /srv/quai-backup ext4 rw 0 0";
    expect(findMountFor(withSibling, "/srv/quai-backup").type).toBe("ext4");
  });

  test("octal escapes in mount points are decoded", () => {
    const escaped = "/dev/sde /srv/my\\040volume xfs rw,prjquota 0 0";
    expect(findMountFor(escaped, "/srv/my volume").options).toContain("prjquota");
  });

  test("an empty mount table yields no filesystem rather than throwing", () => {
    expect(findMountFor("", "/srv/quai").type).toBe("");
  });
});

describe("cgroup path", () => {
  test("a v2 line gives the container path", () => {
    expect(parseCgroupPath("0::/docker/9ba53fc9de0e")).toBe("/docker/9ba53fc9de0e");
  });

  test("the v2 line is picked out of a hybrid file, not the last line", () => {
    // On hybrid hosts /proc/self/cgroup carries v1 lines too; taking the last
    // line would read a v1 controller path and misjudge the namespace.
    const hybrid = ["0::/docker/abc123", "1:name=systemd:/docker/abc123", "2:cpu:/"].join("\n");
    expect(parseCgroupPath(hybrid)).toBe("/docker/abc123");
  });

  test("a bare root means the container sees no path of its own", () => {
    expect(parseCgroupPath("0::/")).toBe("/");
  });

  test("a path containing colons is preserved", () => {
    expect(parseCgroupPath("0::/docker/a:b")).toBe("/docker/a:b");
  });

  test("an unreadable file yields the root rather than throwing", () => {
    expect(parseCgroupPath("")).toBe("/");
  });
});

describe("capabilities", () => {
  // Measured in the prototype: a container run without --cap-add reports
  // CapBnd 00000000a80425fb, which carries neither capability Quai needs.
  const DOCKER_DEFAULT = "00000000a80425fb";
  // The same mask with bit 12 (NET_ADMIN) and bit 21 (SYS_ADMIN) set.
  const WITH_CAP_ADD = "00000000a82435fb";

  test("the default Docker mask grants neither capability Quai requires", () => {
    expect(decodeCapabilities(DOCKER_DEFAULT)).toEqual([]);
  });

  test("decodes NET_ADMIN and SYS_ADMIN once they are added", () => {
    expect(decodeCapabilities(WITH_CAP_ADD).toSorted()).toEqual(["NET_ADMIN", "SYS_ADMIN"]);
  });

  test("NET_ADMIN alone is decoded without implying SYS_ADMIN", () => {
    expect(decodeCapabilities("0000000000001000")).toEqual(["NET_ADMIN"]);
  });

  test("SYS_ADMIN alone is decoded without implying NET_ADMIN", () => {
    expect(decodeCapabilities("0000000000200000")).toEqual(["SYS_ADMIN"]);
  });

  test("an empty mask reports nothing", () => {
    expect(decodeCapabilities("0000000000000000")).toEqual([]);
  });

  test("an unparseable mask reports nothing rather than throwing", () => {
    expect(decodeCapabilities("")).toEqual([]);
  });
});
