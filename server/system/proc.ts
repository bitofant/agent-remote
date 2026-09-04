// /proc and /sys readers for the System state page.
//
// Each export comes in two halves: a pure `parse*` over the file's text (unit
// tested, no fs) and a thin `read*` that does the I/O. The split is what keeps
// `npm test` process-free and machine-independent — these formats are stable
// kernel ABI, so a fixture is as good as the real file.
//
// Linux-only by construction. Callers treat a throw as "section unavailable".
import { readFileSync, readdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import type { CpuTicks } from "./delta.js";

/** /proc/diskstats reports I/O in 512-byte sectors regardless of block size. */
const SECTOR_BYTES = 512;

// --- /proc/stat -------------------------------------------------------------

/** Aggregate line first ("cpu"), then one per core ("cpu0"..). Lines from
 * older/other kernels may omit the trailing steal/guest columns, so every
 * field past `idle` is optional. */
export function parseProcStat(text: string): CpuTicks[] {
  const out: CpuTicks[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const parts = line.trim().split(/\s+/);
    const name = parts[0];
    if (!/^cpu\d*$/.test(name)) continue;
    const n = (i: number) => Number(parts[i + 1]) || 0;
    out.push({
      name,
      user: n(0),
      nice: n(1),
      system: n(2),
      idle: n(3),
      iowait: n(4),
      irq: n(5),
      softirq: n(6),
      steal: n(7),
    });
  }
  return out;
}

export const readProcStat = (): CpuTicks[] =>
  parseProcStat(readFileSync("/proc/stat", "utf8"));

// --- /proc/meminfo ----------------------------------------------------------

export interface MemInfo {
  totalKb: number;
  freeKb: number;
  availableKb: number;
  buffersKb: number;
  cachedKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
}

/** Values are already in kB. `MemAvailable` is the number users expect for
 * "free"; very old kernels lack it, so fall back to free+buffers+cached. */
export function parseMeminfo(text: string): MemInfo {
  const map = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) map.set(m[1], Number(m[2]));
  }
  const get = (k: string) => map.get(k) ?? 0;
  const free = get("MemFree");
  const buffers = get("Buffers");
  const cached = get("Cached");
  return {
    totalKb: get("MemTotal"),
    freeKb: free,
    availableKb: map.get("MemAvailable") ?? free + buffers + cached,
    buffersKb: buffers,
    cachedKb: cached,
    swapTotalKb: get("SwapTotal"),
    swapFreeKb: get("SwapFree"),
  };
}

export const readMeminfo = (): MemInfo =>
  parseMeminfo(readFileSync("/proc/meminfo", "utf8"));

// --- /proc/loadavg + /proc/uptime -------------------------------------------

export function parseLoadAvg(text: string): [number, number, number] {
  const p = text.trim().split(/\s+/);
  return [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0];
}

export const parseUptime = (text: string): number =>
  Number(text.trim().split(/\s+/)[0]) || 0;

// --- /proc/net/dev ----------------------------------------------------------

export interface NetCounters {
  name: string;
  rxBytes: number;
  txBytes: number;
}

/** Skips the two header lines. Interface names can butt straight against the
 * colon with no space AND against a wide byte count ("eth0:123456"), so split
 * on the colon rather than on whitespace. */
export function parseNetDev(text: string): NetCounters[] {
  const out: NetCounters[] = [];
  for (const line of text.split("\n").slice(2)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    if (!name) continue;
    const cols = line.slice(idx + 1).trim().split(/\s+/);
    if (cols.length < 9) continue;
    out.push({
      name,
      rxBytes: Number(cols[0]) || 0,
      txBytes: Number(cols[8]) || 0,
    });
  }
  return out;
}

export const readNetDev = (): NetCounters[] =>
  parseNetDev(readFileSync("/proc/net/dev", "utf8"));

/** Virtual/bridge plumbing nobody wants on a dashboard. */
const BORING_IFACE = /^(lo|veth|br-|docker\d|virbr|tap|tun|dummy)/;
export const isInterestingIface = (name: string) => !BORING_IFACE.test(name);

// --- /proc/diskstats --------------------------------------------------------

export interface DiskCounters {
  device: string;
  readBytes: number;
  writeBytes: number;
  /** io_ticks: ms the device spent with I/O in flight; a busy% numerator. */
  ioMs: number;
}

/** Whole disks only — partitions double-count their parent's traffic. The
 * 14-field (pre-4.18) and 18/20-field layouts share the first 11 fields, which
 * is everything we read. */
export function parseDiskstats(text: string): DiskCounters[] {
  const out: DiskCounters[] = [];
  for (const line of text.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    const device = p[2];
    if (!isWholeDisk(device)) continue;
    out.push({
      device,
      readBytes: (Number(p[5]) || 0) * SECTOR_BYTES,
      writeBytes: (Number(p[9]) || 0) * SECTOR_BYTES,
      ioMs: Number(p[12]) || 0,
    });
  }
  return out;
}

/** `nvme0n1` yes, `nvme0n1p2` no; `sda` yes, `sda1` no. Also drops ram/loop. */
export function isWholeDisk(device: string): boolean {
  if (/^(ram|loop|fd|sr)\d/.test(device)) return false;
  if (/^nvme\d+n\d+p\d+$/.test(device)) return false;
  if (/^mmcblk\d+p\d+$/.test(device)) return false;
  if (/^(sd|vd|hd)[a-z]+\d+$/.test(device)) return false;
  if (/^dm-\d+$/.test(device)) return false;
  return true;
}

export const readDiskstats = (): DiskCounters[] =>
  parseDiskstats(readFileSync("/proc/diskstats", "utf8"));

// --- /proc/mounts -----------------------------------------------------------

export interface MountEntry {
  device: string;
  mount: string;
  fstype: string;
}

/** Local filesystems only. An allowlist (not a denylist) keeps `statfs` off
 * network mounts, which block indefinitely when the server is unreachable. */
const LOCAL_FS = new Set([
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "zfs",
  "f2fs",
  "vfat",
  "exfat",
  "ntfs",
  "ntfs3",
]);

/** Deduped by device: bind mounts and btrfs subvolumes otherwise report the
 * same filesystem several times. */
export function parseMounts(text: string): MountEntry[] {
  const seen = new Set<string>();
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const p = line.split(/\s+/);
    if (p.length < 3) continue;
    const [device, mount, fstype] = p;
    if (!LOCAL_FS.has(fstype)) continue;
    if (seen.has(device)) continue;
    seen.add(device);
    // /proc/mounts octal-escapes spaces and friends.
    out.push({ device, mount: unescapeMount(mount), fstype });
  }
  return out;
}

const unescapeMount = (s: string) =>
  s.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

export const readMounts = (): MountEntry[] =>
  parseMounts(readFileSync("/proc/mounts", "utf8"));

export interface MountUsage extends MountEntry {
  totalBytes: number;
  freeBytes: number;
  usedPct: number;
}

/** statfs each mount; a failing one is dropped rather than failing the set. */
export async function readMountUsage(
  mounts: MountEntry[],
): Promise<MountUsage[]> {
  const out: MountUsage[] = [];
  for (const m of mounts) {
    try {
      const s = await statfs(m.mount);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      if (total <= 0) continue;
      out.push({
        ...m,
        totalBytes: total,
        freeBytes: free,
        usedPct: ((total - free) / total) * 100,
      });
    } catch {
      // Unreadable mount: skip it, keep the rest.
    }
  }
  return out;
}

// --- /sys/class/hwmon -------------------------------------------------------

export interface HwmonChip {
  dir: string;
  name: string;
}

/** hwmon indices are NOT stable across boots, so a chip is always located by
 * reading its `name` — never by hardcoding hwmon0. This box has no
 * /sys/class/thermal/thermal_zone*, so there is no fallback to it. */
export function pickHwmon(chips: HwmonChip[], names: string[]): string | null {
  for (const want of names) {
    const hit = chips.find((c) => c.name === want);
    if (hit) return hit.dir;
  }
  return null;
}

/** CPU package sensors, best first: AMD Zen, Intel, then generic. */
export const CPU_SENSORS = ["k10temp", "coretemp", "zenpower", "cpu_thermal"];
export const NVME_SENSORS = ["nvme"];

export const milliToC = (raw: number): number | null =>
  Number.isFinite(raw) && raw !== 0 ? raw / 1000 : null;

export function readHwmonChips(): HwmonChip[] {
  const root = "/sys/class/hwmon";
  const out: HwmonChip[] = [];
  for (const entry of readdirSync(root)) {
    try {
      const dir = `${root}/${entry}`;
      out.push({ dir, name: readFileSync(`${dir}/name`, "utf8").trim() });
    } catch {
      // Chip vanished mid-scan (hotplug); ignore it.
    }
  }
  return out;
}

export interface HwmonReading {
  tempC: number | null;
  /** The chip's own throttle/critical point, when it publishes one. Null means
   * "no scale is known" — the UI then shows a number, never a gauge, rather
   * than inventing a ceiling to draw a bar against. */
  limitC: number | null;
}

const readMilliC = (path: string): number | null => {
  try {
    return milliToC(Number(readFileSync(path, "utf8").trim()));
  } catch {
    return null;
  }
};

/** First temp input on a chip, plus its limit if one is exposed. `crit` before
 * `max`: both are throttle points, crit is the harder one. k10temp publishes
 * neither on this box, so CPU temp legitimately has no gauge here. */
export function readHwmonTemp(dir: string | null): HwmonReading {
  if (!dir) return { tempC: null, limitC: null };
  return {
    tempC: readMilliC(`${dir}/temp1_input`),
    limitC: readMilliC(`${dir}/temp1_crit`) ?? readMilliC(`${dir}/temp1_max`),
  };
}
