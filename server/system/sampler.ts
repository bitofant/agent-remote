// The System state sampler: one cached snapshot, refreshed on timers, served
// by GET /api/system without any I/O on the request path.
//
// Two properties are load-bearing:
//  - The GET is the heartbeat. Sampling starts on the first request and stops
//    ~15s after the last one, so a closed page costs nothing and N open tabs
//    cost exactly one sampler — no WS subscription bookkeeping.
//  - Sections fail independently. Every probe is wrapped; a failure sets the
//    section to null with a reason instead of blanking the page or throwing.
import { readFileSync } from "node:fs";
import { cpus, hostname, release } from "node:os";
import type { LlmConfig } from "../config.js";
import type { ContainerInfo, SystemSnapshot } from "../../shared/protocol.js";
import { cpuPercent, rateOf, type CpuTicks } from "./delta.js";
import {
  mergeContainers,
  probeDockerPs,
  probeDockerStats,
  type PsRow,
  type StatsRow,
} from "./docker.js";
import { probeEngine, type EngineCounters } from "./engine.js";
import { probeGpu } from "./gpu.js";
import {
  CPU_SENSORS,
  NVME_SENSORS,
  isInterestingIface,
  parseLoadAvg,
  parseUptime,
  pickHwmon,
  readDiskstats,
  readHwmonChips,
  readHwmonTemp,
  readMeminfo,
  readMountUsage,
  readMounts,
  readNetDev,
  readProcStat,
  type DiskCounters,
  type NetCounters,
} from "./proc.js";

const TICK_MS = 2000;
const PS_MS = 5000;
/** `docker stats` blocks for ~1s, so it gets its own slow timer. */
const STATS_MS = 10_000;
const HWMON_TTL_MS = 60_000;
/** Stop sampling once no browser has asked for a while. */
const IDLE_STOP_MS = 15_000;
/** A missing binary must not be respawned every tick. */
const PROBE_BACKOFF_MS = 300_000;

const firstLine = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0].trim() || "Failed.";
};

interface Counters {
  at: number;
  cpu: Map<string, CpuTicks>;
  net: Map<string, NetCounters>;
  disk: Map<string, DiskCounters>;
}

/** Remembers a failing probe so we back off instead of retrying every tick. */
class Probe {
  private failedAt = 0;
  private reason = "";
  ok(): boolean {
    return Date.now() - this.failedAt >= PROBE_BACKOFF_MS;
  }
  fail(e: unknown): string {
    this.failedAt = Date.now();
    this.reason = firstLine(e);
    return this.reason;
  }
  clear(): void {
    this.failedAt = 0;
    this.reason = "";
  }
  get lastReason(): string {
    return this.reason;
  }
}

const emptySnapshot = (): SystemSnapshot => ({
  at: 0,
  host: {
    hostname: hostname(),
    platform: process.platform,
    release: release(),
    uptimeSec: 0,
    loadAvg: [0, 0, 0],
    cpuModel: cpus()[0]?.model ?? null,
    cpuCount: cpus().length,
  },
  cpu: null,
  memory: null,
  disks: null,
  network: null,
  gpu: null,
  engine: null,
  containers: null,
  errors: {},
});

let snapshot: SystemSnapshot = emptySnapshot();
let llm: LlmConfig | null = null;

let prev: Counters | null = null;
let engineCounters: EngineCounters | null = null;

let hwmon: { at: number; cpu: string | null; nvme: string | null } | null = null;

let psRows: PsRow[] | null = null;
let statsRows: StatsRow[] = [];
let statsAt: number | null = null;

const gpuProbe = new Probe();
const dockerProbe = new Probe();

let ticking = false;
let gpuInFlight = false;
let statsInFlight = false;
let psAt = 0;
let statsRunAt = 0;

let timer: ReturnType<typeof setInterval> | null = null;
let lastSeenAt = 0;

// --- host + /proc sections --------------------------------------------------

function sampleHost(next: SystemSnapshot, errors: SystemSnapshot["errors"]): Counters {
  const now = Date.now();
  const counters: Counters = {
    at: now,
    cpu: new Map(),
    net: new Map(),
    disk: new Map(),
  };
  const dt = prev ? now - prev.at : 0;

  if (Date.now() - (hwmon?.at ?? 0) > HWMON_TTL_MS) {
    try {
      const chips = readHwmonChips();
      hwmon = {
        at: Date.now(),
        cpu: pickHwmon(chips, CPU_SENSORS),
        nvme: pickHwmon(chips, NVME_SENSORS),
      };
    } catch {
      hwmon = { at: Date.now(), cpu: null, nvme: null };
    }
  }

  // uptime + load come from /proc too, but a failure there shouldn't cost us
  // the CPU section, so they're read separately.
  try {
    next.host.uptimeSec = parseUptime(readFileSync("/proc/uptime", "utf8"));
    next.host.loadAvg = parseLoadAvg(readFileSync("/proc/loadavg", "utf8"));
  } catch {
    // Leave the defaults; a failure here mustn't cost us the CPU section.
  }

  const cpuTemp = readHwmonTemp(hwmon?.cpu ?? null);
  try {
    const ticks = readProcStat();
    for (const t of ticks) counters.cpu.set(t.name, t);
    const agg = cpuPercent(prev?.cpu.get("cpu"), counters.cpu.get("cpu"));
    const perCore: number[] = [];
    for (const t of ticks) {
      if (t.name === "cpu") continue;
      const p = cpuPercent(prev?.cpu.get(t.name), t);
      if (p) perCore.push(p.usagePct);
    }
    next.cpu = {
      usagePct: agg?.usagePct ?? null,
      perCorePct: perCore,
      userPct: agg?.userPct ?? null,
      systemPct: agg?.systemPct ?? null,
      iowaitPct: agg?.iowaitPct ?? null,
      tempC: cpuTemp.tempC,
      tempLimitC: cpuTemp.limitC,
    };
  } catch (e) {
    errors.cpu = firstLine(e);
  }

  try {
    const m = readMeminfo();
    next.memory = {
      ...m,
      usedPct: m.totalKb > 0 ? ((m.totalKb - m.availableKb) / m.totalKb) * 100 : 0,
    };
  } catch (e) {
    errors.memory = firstLine(e);
  }

  try {
    const ifaces = readNetDev().filter((i) => isInterestingIface(i.name));
    for (const i of ifaces) counters.net.set(i.name, i);
    next.network = {
      interfaces: ifaces.map((i) => ({
        name: i.name,
        rxBytes: i.rxBytes,
        txBytes: i.txBytes,
        rxBps: rateOf(prev?.net.get(i.name)?.rxBytes, i.rxBytes, dt),
        txBps: rateOf(prev?.net.get(i.name)?.txBytes, i.txBytes, dt),
      })),
    };
  } catch (e) {
    errors.network = firstLine(e);
  }

  return counters;
}

async function sampleDisks(
  next: SystemSnapshot,
  errors: SystemSnapshot["errors"],
  counters: Counters,
): Promise<void> {
  const dt = prev ? counters.at - prev.at : 0;
  try {
    const io = readDiskstats();
    for (const d of io) counters.disk.set(d.device, d);
    const nvme = readHwmonTemp(hwmon?.nvme ?? null);
    const mounts = await readMountUsage(readMounts());
    next.disks = {
      mounts: mounts.map((m) => ({
        mount: m.mount,
        device: m.device,
        totalBytes: m.totalBytes,
        freeBytes: m.freeBytes,
        usedPct: m.usedPct,
      })),
      io: io.map((d) => {
        const p = prev?.disk.get(d.device);
        const ioDelta = rateOf(p?.ioMs, d.ioMs, dt);
        return {
          device: d.device,
          readBps: rateOf(p?.readBytes, d.readBytes, dt),
          writeBps: rateOf(p?.writeBytes, d.writeBytes, dt),
          // io_ticks is ms busy per second of wall clock -> percent.
          utilPct: ioDelta == null ? null : Math.min(100, ioDelta / 10),
          tempC: d.device.startsWith("nvme") ? nvme.tempC : null,
          tempLimitC: d.device.startsWith("nvme") ? nvme.limitC : null,
        };
      }),
    };
  } catch (e) {
    errors.disks = firstLine(e);
  }
}

// --- spawned / networked sections -------------------------------------------

async function sampleGpu(
  next: SystemSnapshot,
  errors: SystemSnapshot["errors"],
): Promise<void> {
  if (gpuInFlight) {
    next.gpu = snapshot.gpu; // keep the previous frame rather than blanking
    return;
  }
  if (!gpuProbe.ok()) {
    errors.gpu = gpuProbe.lastReason;
    return;
  }
  gpuInFlight = true;
  try {
    const { gpus, processes, driverVersion } = await probeGpu();
    // probeGpu leaves the cgroup container ID here; swap it for the readable
    // name. `docker ps` prints 12-char ids, the cgroup carries the full 64.
    const rows = psRows;
    for (const p of processes) {
      if (!p.container) continue;
      const id = p.container;
      p.container = rows?.find((r) => id.startsWith(r.id))?.name ?? null;
    }
    next.gpu = { gpus, processes, driverVersion };
    gpuProbe.clear();
  } catch (e) {
    errors.gpu = gpuProbe.fail(e);
  } finally {
    gpuInFlight = false;
  }
}

async function sampleDocker(
  next: SystemSnapshot,
  errors: SystemSnapshot["errors"],
): Promise<void> {
  const now = Date.now();
  if (dockerProbe.ok() && now - psAt >= PS_MS) {
    psAt = now;
    try {
      psRows = await probeDockerPs();
      dockerProbe.clear();
    } catch (e) {
      psRows = null;
      dockerProbe.fail(e);
    }
  }
  // The ~1s stats pass runs on its own slow timer and never blocks the tick.
  if (dockerProbe.ok() && !statsInFlight && now - statsRunAt >= STATS_MS) {
    statsRunAt = now;
    statsInFlight = true;
    void probeDockerStats()
      .then((rows) => {
        statsRows = rows;
        statsAt = Date.now();
      })
      .catch(() => {
        statsRows = [];
      })
      .finally(() => {
        statsInFlight = false;
      });
  }
  if (psRows) {
    const containers: ContainerInfo[] = mergeContainers(psRows, statsRows);
    next.containers = { containers, statsAt };
  } else {
    errors.containers = dockerProbe.lastReason || "docker unavailable.";
  }
}

async function sampleEngine(
  next: SystemSnapshot,
  errors: SystemSnapshot["errors"],
): Promise<void> {
  if (!llm?.baseUrl) {
    errors.engine = "No llm.baseUrl configured.";
    return;
  }
  try {
    const { section, counters, error } = await probeEngine(
      llm.baseUrl,
      psRows,
      engineCounters,
    );
    engineCounters = counters;
    next.engine = section;
    if (error) errors.engine = error;
  } catch (e) {
    errors.engine = firstLine(e);
  }
}

// --- the tick ---------------------------------------------------------------

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const next = emptySnapshot();
    const errors = next.errors;
    // Build into a fresh object and publish once, so a GET mid-tick never sees
    // a half-updated frame.
    const counters = sampleHost(next, errors);
    await Promise.allSettled([
      sampleDisks(next, errors, counters),
      sampleDocker(next, errors),
      sampleGpu(next, errors),
    ]);
    // Engine detection reads psRows, so it runs after docker.
    await sampleEngine(next, errors);
    next.at = Date.now();
    prev = counters;
    snapshot = next;
  } finally {
    ticking = false;
  }
}

function startTimers(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (Date.now() - lastSeenAt > IDLE_STOP_MS) {
      stopTimers();
      return;
    }
    void tick();
  }, TICK_MS);
  timer.unref?.();
}

function stopTimers(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Wire at boot. Stores config and takes one cheap /proc sample so the first
 * GET is never empty; starts no timers until a browser actually looks. */
export function startSystemSampling(config: { llm: LlmConfig }): void {
  llm = config.llm;
  try {
    const next = emptySnapshot();
    prev = sampleHost(next, next.errors);
    next.at = Date.now();
    snapshot = next;
  } catch {
    // Non-Linux or a locked-down /proc: the page will show why per section.
  }
}

/** Called by the route: "a browser is watching". Starts sampling if stopped
 * and kicks an immediate tick so the first frame isn't one interval late. */
export function noteSystemWatcher(): void {
  const wasIdle = !timer;
  lastSeenAt = Date.now();
  startTimers();
  if (wasIdle) void tick();
}

/** Latest cached snapshot. Cheap; never throws. */
export function systemSnapshot(): SystemSnapshot {
  return snapshot;
}

/** Test/diagnostic hook: force one sampling pass and return the result. */
export async function sampleOnce(): Promise<SystemSnapshot> {
  await tick();
  return snapshot;
}
