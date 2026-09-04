import { describe, expect, it } from "vitest";
import {
  CPU_SENSORS,
  isInterestingIface,
  isWholeDisk,
  milliToC,
  parseDiskstats,
  parseLoadAvg,
  parseMeminfo,
  parseMounts,
  parseNetDev,
  parseProcStat,
  parseUptime,
  pickHwmon,
} from "./proc.js";

describe("parseProcStat", () => {
  const REAL = `cpu  11664591 2793 273707 734889891 35123 0 23159 0 0 0
cpu0 328305 32 12437 30767482 1656 0 4439 0 0 0
cpu1 470453 1166 61466 30563148 6227 0 3409 0 0 0
intr 123 456
ctxt 99999
procs_running 2`;

  it("reads the aggregate line first, then one per core", () => {
    const out = parseProcStat(REAL);
    expect(out.map((c) => c.name)).toEqual(["cpu", "cpu0", "cpu1"]);
    expect(out[0].user).toBe(11664591);
    expect(out[0].idle).toBe(734889891);
    expect(out[0].iowait).toBe(35123);
    expect(out[0].softirq).toBe(23159);
  });

  it("ignores non-cpu lines, including ones merely starting with 'cpu'", () => {
    const out = parseProcStat("cpu 1 2 3 4\ncpufreq 9 9 9 9\nctxt 5");
    expect(out).toHaveLength(1);
  });

  it("defaults the trailing columns older kernels omit", () => {
    const out = parseProcStat("cpu 100 20 30 400");
    expect(out[0].idle).toBe(400);
    expect(out[0].iowait).toBe(0);
    expect(out[0].steal).toBe(0);
  });
});

describe("parseMeminfo", () => {
  const REAL = `MemTotal:       96428264 kB
MemFree:         6875816 kB
MemAvailable:   90252324 kB
Buffers:          531668 kB
Cached:         82695108 kB
SwapCached:          352 kB
SwapTotal:       8388604 kB
SwapFree:        8000000 kB`;

  it("reads the fields it needs, in kB", () => {
    const m = parseMeminfo(REAL);
    expect(m.totalKb).toBe(96428264);
    expect(m.availableKb).toBe(90252324);
    expect(m.buffersKb).toBe(531668);
    expect(m.swapTotalKb).toBe(8388604);
    expect(m.swapFreeKb).toBe(8000000);
  });

  it("prefers MemAvailable over free+buffers+cached", () => {
    // MemAvailable is deliberately not the sum, so the fallback is detectable.
    expect(parseMeminfo(REAL).availableKb).toBe(90252324);
  });

  it("falls back to free+buffers+cached when MemAvailable is absent", () => {
    const old = `MemTotal: 1000 kB
MemFree: 100 kB
Buffers: 20 kB
Cached: 30 kB`;
    expect(parseMeminfo(old).availableKb).toBe(150);
  });

  it("reports zeros rather than NaN for a truncated file", () => {
    const m = parseMeminfo("");
    expect(m.totalKb).toBe(0);
    expect(m.availableKb).toBe(0);
  });
});

describe("parseLoadAvg / parseUptime", () => {
  it("reads the three load figures", () => {
    expect(parseLoadAvg("0.15 0.12 0.09 1/2345 67890")).toEqual([
      0.15, 0.12, 0.09,
    ]);
  });

  it("reads uptime seconds, ignoring the idle figure", () => {
    expect(parseUptime("311287.75 7348899.03")).toBeCloseTo(311287.75, 2);
  });
});

describe("parseNetDev", () => {
  const REAL = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 616769879 1097443    0    0    0     0          0         0 616769879 1097443    0    0    0     0       0          0
enp10s0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0`;

  it("skips both header lines and reads rx/tx bytes", () => {
    const out = parseNetDev(REAL);
    expect(out.map((i) => i.name)).toEqual(["lo", "enp10s0"]);
    expect(out[0].rxBytes).toBe(616769879);
    expect(out[0].txBytes).toBe(616769879);
    expect(out[1].rxBytes).toBe(0);
  });

  it("handles a wide byte count butting against the colon", () => {
    const line = `h1
h2
eth0:1234567890123 100 0 0 0 0 0 0 55 10 0 0 0 0 0 0`;
    const out = parseNetDev(line);
    expect(out[0].name).toBe("eth0");
    expect(out[0].rxBytes).toBe(1234567890123);
    expect(out[0].txBytes).toBe(55);
  });

  it("filters virtual plumbing out of the display set", () => {
    expect(isInterestingIface("enp10s0")).toBe(true);
    expect(isInterestingIface("wlan0")).toBe(true);
    for (const boring of ["lo", "veth1a2b", "br-abc123", "docker0", "virbr0"])
      expect(isInterestingIface(boring)).toBe(false);
  });
});

describe("parseDiskstats", () => {
  const REAL =
    " 259       0 nvme0n1 3600207 83833 265565598 263426 1712764 882633 289949450 2055170 0 379199 2367041 0 0 0 0 61671 48444\n" +
    " 259       2 nvme0n1p2 100 0 200 10 50 0 100 5 0 20 30 0 0 0 0 0 0\n" +
    "   7       0 loop0 10 0 20 1 0 0 0 0 0 1 1";

  it("converts sectors to bytes and reads io_ticks", () => {
    const out = parseDiskstats(REAL);
    expect(out).toHaveLength(1);
    expect(out[0].device).toBe("nvme0n1");
    expect(out[0].readBytes).toBe(265565598 * 512);
    expect(out[0].writeBytes).toBe(289949450 * 512);
    expect(out[0].ioMs).toBe(379199);
  });

  it("drops partitions and loop devices", () => {
    expect(parseDiskstats(REAL).map((d) => d.device)).toEqual(["nvme0n1"]);
  });

  it("accepts the shorter pre-4.18 layout (first 11 fields are shared)", () => {
    const old = " 8 0 sda 1 2 100 4 5 6 200 8 0 900 10";
    const out = parseDiskstats(old);
    expect(out[0].readBytes).toBe(100 * 512);
    expect(out[0].ioMs).toBe(900);
  });

  it("classifies whole disks vs partitions", () => {
    for (const whole of ["nvme0n1", "sda", "vdb", "mmcblk0"])
      expect(isWholeDisk(whole)).toBe(true);
    for (const part of ["nvme0n1p1", "sda1", "mmcblk0p2", "loop3", "dm-0"])
      expect(isWholeDisk(part)).toBe(false);
  });
});

describe("parseMounts", () => {
  const REAL = `/dev/mapper/ubuntu--vg-ubuntu--lv / ext4 rw,relatime 0 0
/dev/nvme0n1p2 /boot ext4 rw,relatime 0 0
/dev/nvme0n1p1 /boot/efi vfat rw,relatime,fmask=0022 0 0
proc /proc proc rw,nosuid 0 0
tmpfs /run tmpfs rw,nosuid 0 0
server:/export /mnt/nfs nfs4 rw 0 0`;

  it("keeps only local filesystems", () => {
    const out = parseMounts(REAL);
    expect(out.map((m) => m.mount)).toEqual(["/", "/boot", "/boot/efi"]);
  });

  it("excludes network mounts, which would block statfs", () => {
    expect(parseMounts(REAL).some((m) => m.fstype === "nfs4")).toBe(false);
  });

  it("dedupes by device so bind mounts appear once", () => {
    const dup = `/dev/sda1 / ext4 rw 0 0
/dev/sda1 /mnt/bind ext4 rw 0 0`;
    expect(parseMounts(dup)).toHaveLength(1);
  });

  it("unescapes octal-escaped mount points", () => {
    const esc = "/dev/sdb1 /mnt/my\\040disk ext4 rw 0 0";
    expect(parseMounts(esc)[0].mount).toBe("/mnt/my disk");
  });
});

describe("pickHwmon", () => {
  // hwmon indices are not stable across boots — this is the regression.
  const CHIPS = [
    { dir: "/sys/class/hwmon/hwmon0", name: "nvme" },
    { dir: "/sys/class/hwmon/hwmon1", name: "enp11s0" },
    { dir: "/sys/class/hwmon/hwmon2", name: "k10temp" },
    { dir: "/sys/class/hwmon/hwmon3", name: "amdgpu" },
  ];

  it("locates a chip by name, not by index", () => {
    expect(pickHwmon(CHIPS, CPU_SENSORS)).toBe("/sys/class/hwmon/hwmon2");
  });

  it("survives the indices being shuffled by a reboot", () => {
    const shuffled = [...CHIPS].reverse();
    expect(pickHwmon(shuffled, CPU_SENSORS)).toBe("/sys/class/hwmon/hwmon2");
  });

  it("honours the preference order of the requested names", () => {
    const both = [
      { dir: "/a", name: "coretemp" },
      { dir: "/b", name: "k10temp" },
    ];
    expect(pickHwmon(both, ["k10temp", "coretemp"])).toBe("/b");
    expect(pickHwmon(both, ["coretemp", "k10temp"])).toBe("/a");
  });

  it("is null when no sensor matches", () => {
    expect(pickHwmon(CHIPS, ["nosuchchip"])).toBeNull();
    expect(pickHwmon([], CPU_SENSORS)).toBeNull();
  });
});

describe("milliToC", () => {
  it("converts milli-degrees to °C", () => {
    expect(milliToC(55250)).toBeCloseTo(55.25, 4);
  });

  it("treats 0 and junk as no reading", () => {
    expect(milliToC(0)).toBeNull();
    expect(milliToC(Number.NaN)).toBeNull();
  });
});
