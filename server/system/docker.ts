// Docker probing for the System state page: the container list, their resource
// use, and the port→container lookup the LLM engine section uses to name the
// container serving the configured endpoint.
//
// Never throws past `probe*`: the sampler turns a failure into a section reason
// and backs off, so an uninstalled docker (or a user outside the docker group)
// costs one failed spawn every few minutes rather than one every tick.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContainerInfo } from "../../shared/protocol.js";

const execFileAsync = promisify(execFile);

const PS_TIMEOUT_MS = 5000;
/** `docker stats` samples for ~1s before printing even with --no-stream. */
const STATS_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 1 << 20;
/** A host with hundreds of containers shouldn't ship them all every poll. */
export const MAX_CONTAINERS = 50;

const PS_FORMAT =
  "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}";
const STATS_FORMAT = "{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}";

export interface PsRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  /** Raw published-port strings, as docker prints them. */
  ports: string[];
}

export function parsePsLines(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const c = line.split("\t");
    if (c.length < 6) continue;
    rows.push({
      id: c[0].trim(),
      name: c[1].trim(),
      image: c[2].trim(),
      state: c[3].trim(),
      status: c[4].trim(),
      ports: c[5]
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    });
  }
  return rows.slice(0, MAX_CONTAINERS);
}

/** Host ports from a docker ports column. Handles the `[::]` duplicate of each
 * mapping and ranges (`0.0.0.0:18789-18790->18789-18790/tcp`), which would
 * otherwise hide a match. Unpublished ports ("8188/tcp") have no host side. */
export function parsePorts(ports: string[] | string): number[] {
  const list = typeof ports === "string" ? ports.split(",") : ports;
  const found = new Set<number>();
  for (const entry of list) {
    const m = /:(\d+)(?:-(\d+))?->/.exec(entry.trim());
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    // Guard against a malformed descending range spinning the loop.
    for (let p = from; p <= to && p - from < 1024; p++) found.add(p);
  }
  return [...found].sort((a, b) => a - b);
}

/** The container publishing `port` on the host, if any. */
export function containerForPort(rows: PsRow[], port: number): PsRow | null {
  return rows.find((r) => parsePorts(r.ports).includes(port)) ?? null;
}

export interface StatsRow {
  id: string;
  cpuPct: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

/** Docker mixes unit systems in one line: MemUsage is binary (MiB/GiB) while
 * NetIO is decimal (kB/MB). Parse both rather than assuming either. */
export function parseSize(text: string): number | null {
  const m = /^([\d.]+)\s*([a-zA-Z]*)$/.exec(text.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2].toLowerCase();
  const scale: Record<string, number> = {
    "": 1,
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  const factor = scale[unit];
  return factor == null ? null : value * factor;
}

const pair = (text: string): [number | null, number | null] => {
  const [a, b] = text.split("/");
  return [parseSize(a ?? ""), parseSize(b ?? "")];
};

export function parseStatsLines(out: string): StatsRow[] {
  const rows: StatsRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const c = line.split("\t");
    if (c.length < 4) continue;
    const cpu = Number(c[1].replace("%", "").trim());
    const [memUsed, memLimit] = pair(c[2]);
    const [rx, tx] = pair(c[3]);
    rows.push({
      id: c[0].trim(),
      cpuPct: Number.isFinite(cpu) ? cpu : null,
      memUsedBytes: memUsed,
      memLimitBytes: memLimit,
      netRxBytes: rx,
      netTxBytes: tx,
    });
  }
  return rows;
}

/** Join the cheap listing to the expensive stats pass, which runs on its own
 * slower timer — so a container always appears, with or without its numbers. */
export function mergeContainers(
  rows: PsRow[],
  stats: StatsRow[],
): ContainerInfo[] {
  const byId = new Map(stats.map((s) => [s.id, s]));
  return rows.map((r) => {
    const s = byId.get(r.id);
    return {
      id: r.id,
      name: r.name,
      image: r.image,
      state: r.state,
      status: r.status,
      ports: r.ports,
      cpuPct: s?.cpuPct ?? null,
      memUsedBytes: s?.memUsedBytes ?? null,
      memLimitBytes: s?.memLimitBytes ?? null,
      netRxBytes: s?.netRxBytes ?? null,
      netTxBytes: s?.netTxBytes ?? null,
    };
  });
}

export async function probeDockerPs(): Promise<PsRow[]> {
  const { stdout } = await execFileAsync(
    "docker",
    ["ps", "--format", PS_FORMAT],
    { timeout: PS_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
  );
  return parsePsLines(stdout);
}

/** ~1s per call — never on the request path or the fast tick. */
export async function probeDockerStats(): Promise<StatsRow[]> {
  const { stdout } = await execFileAsync(
    "docker",
    ["stats", "--no-stream", "--format", STATS_FORMAT],
    { timeout: STATS_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
  );
  return parseStatsLines(stdout);
}
