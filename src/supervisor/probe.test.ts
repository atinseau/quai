import { describe, expect, test } from "bun:test";
import { parseProbe, type RawSystemReadings } from "./probe";

// Readings as they actually look on a correctly provisioned host.
const readings: RawSystemReadings = {
  selfCgroup: "0::/docker/9ba53fc9de0e4651c1637732796a8fc96dc661491d6e90b8d9bb04202e5ccba5",
  cgroupControllers: "cpuset cpu io memory pids",
  cgroupMountOptions: "rw,nosuid,nodev,noexec,relatime",
  homesFilesystemType: "xfs",
  homesMountOptions: "rw,relatime,attr2,inode64,prjquota",
  capabilityBoundingSet: ["NET_ADMIN", "SYS_ADMIN", "CHOWN", "SETUID"],
};

describe("system probe", () => {
  test("a host cgroup path is recognised", () => {
    expect(parseProbe(readings).cgroupNamespace).toBe("host");
  });

  test("a bare root cgroup path means a private namespace", () => {
    // The prototype's failing case: the container sees itself at the root and
    // cannot move any process into a capped cgroup.
    expect(parseProbe({ ...readings, selfCgroup: "0::/" }).cgroupNamespace).toBe("private");
  });

  test("controllers are split into a list", () => {
    expect(parseProbe(readings).cgroupControllers).toEqual([
      "cpuset",
      "cpu",
      "io",
      "memory",
      "pids",
    ]);
  });

  test("a read-only cgroup mount is detected", () => {
    const probe = parseProbe({ ...readings, cgroupMountOptions: "ro,nosuid,nodev" });
    expect(probe.cgroupWritable).toBe(false);
  });

  test("prjquota in the mount options enables disk quotas", () => {
    expect(parseProbe(readings).projectQuotasEnabled).toBe(true);
  });

  test("xfs without prjquota does not enable disk quotas", () => {
    const probe = parseProbe({ ...readings, homesMountOptions: "rw,relatime,attr2,inode64" });
    expect(probe.projectQuotasEnabled).toBe(false);
  });

  test("overlayfs homes never carry quotas, whatever the options claim", () => {
    // Measured in the prototype: /home was overlayfs, which cannot hold quotas.
    const probe = parseProbe({
      ...readings,
      homesFilesystemType: "overlayfs",
      homesMountOptions: "rw,relatime,prjquota",
    });
    expect(probe.projectQuotasEnabled).toBe(false);
  });

  test("a mount option that merely contains the word is not a match", () => {
    const probe = parseProbe({ ...readings, homesMountOptions: "rw,noprjquotafoo" });
    expect(probe.projectQuotasEnabled).toBe(false);
  });

  test("the parsed probe feeds the preflight unchanged", () => {
    const probe = parseProbe(readings);
    expect(probe.capabilities).toContain("NET_ADMIN");
    expect(probe.homesFilesystem).toBe("xfs");
  });
});

