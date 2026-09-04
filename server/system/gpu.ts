// nvidia-smi probing for the System state page. Same never-throw contract as
// server/git.ts: a missing binary is a reason string, not an exception.
//
// NVIDIA only — rocm-smi/intel_gpu_top aren't installed here and their output
// formats differ enough that guessing at them would be fiction. A box without
// nvidia-smi simply reports the GPU section unavailable.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { GpuDevice, GpuProcess } from "../../shared/protocol.js";

const execFileAsync = promisify(execFile);

/** nvidia-smi can stall for a few hundred ms under sustained GPU load. */
const TIMEOUT_MS = 4000;
const MAX_BUFFER = 1 << 20;
/** Long lists are noise on a dashboard and bytes on every poll. */
export const MAX_GPU_PROCESSES = 50;

const GPU_FIELDS = [
  "index",
  "name",
  "utilization.gpu",
  "utilization.memory",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "power.draw",
  "power.limit",
  "fan.speed",
  "clocks.sm",
  "clocks.mem",
  "driver_version",
  // Thermal headroom in °C, NOT an absolute limit — see parseGpuCsv.
  "temperature.gpu.tlimit",
  "clocks.max.sm",
  "clocks.max.mem",
] as const;

/** nvidia-smi writes these for a field the card doesn't expose. They must
 * become null, never 0 — a card with no fan is not a fan at 0%. */
const NOT_A_NUMBER = /^\[?(n\/a|not supported|unknown error)\]?$/i;

export function num(cell: string | undefined): number | null {
  if (cell == null) return null;
  const s = cell.trim();
  if (!s || NOT_A_NUMBER.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const str = (cell: string | undefined): string | null => {
  const s = cell?.trim() ?? "";
  return !s || NOT_A_NUMBER.test(s) ? null : s;
};

const rows = (out: string): string[][] =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(",").map((c) => c.trim()));

/** Parses `--query-gpu=<GPU_FIELDS> --format=csv,noheader,nounits`. */
export function parseGpuCsv(out: string): {
  gpus: GpuDevice[];
  driverVersion: string | null;
} {
  const gpus: GpuDevice[] = [];
  let driverVersion: string | null = null;
  for (const c of rows(out)) {
    if (c.length < GPU_FIELDS.length) continue;
    driverVersion ??= str(c[12]);
    // `temperature.gpu.tlimit` is the *margin* to the throttle point ("GPU
    // Current T.Limit Temp" in nvidia-smi -q), so the absolute ceiling is
    // temp + margin. Reading it as an absolute would draw a 31°C card as
    // dangerously hot.
    const tempC = num(c[6]);
    const margin = num(c[13]);
    gpus.push({
      index: num(c[0]) ?? gpus.length,
      name: str(c[1]) ?? "GPU",
      utilizationPct: num(c[2]),
      memoryUtilPct: num(c[3]),
      memoryUsedMb: num(c[4]),
      memoryTotalMb: num(c[5]),
      tempC,
      tempLimitC: tempC != null && margin != null ? tempC + margin : null,
      powerWatts: num(c[7]),
      powerLimitWatts: num(c[8]),
      fanPct: num(c[9]),
      clockSmMhz: num(c[10]),
      clockMemMhz: num(c[11]),
      clockSmMaxMhz: num(c[14]),
      clockMemMaxMhz: num(c[15]),
    });
  }
  return { gpus, driverVersion };
}

/** Parses `--query-compute-apps=pid,process_name,used_memory`. Empty output
 * (no compute clients) is the normal idle case, not an error. */
export function parseComputeApps(out: string): GpuProcess[] {
  const procs: GpuProcess[] = [];
  for (const c of rows(out)) {
    const pid = num(c[0]);
    if (pid == null) continue;
    procs.push({
      pid,
      name: str(c[1]) ?? "?",
      usedMemoryMb: num(c[2]),
      container: null,
    });
  }
  return procs.slice(0, MAX_GPU_PROCESSES);
}

/** Container id from a /proc/<pid>/cgroup line, or null for a host process.
 * nvidia-smi reports HOST pids even for containerized processes, so this is
 * how a GPU client is attributed to its container — no `docker exec` needed.
 * Only docker is matched: podman/k8s ids don't join to our `docker ps` rows. */
export function containerFromCgroup(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!/docker/.test(line)) continue;
    const m = /docker[-/]([0-9a-f]{12,64})/.exec(line);
    if (m) return m[1];
  }
  return null;
}

export interface GpuProbe {
  gpus: GpuDevice[];
  processes: GpuProcess[];
  driverVersion: string | null;
}

const smi = async (args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("nvidia-smi", args, {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
};

/** Both queries plus cgroup attribution. Throws (with a readable message) when
 * nvidia-smi is absent or fails — the sampler turns that into a section reason
 * and backs off, so a GPU-less box doesn't spawn a failing process every tick. */
export async function probeGpu(): Promise<GpuProbe> {
  const [gpuOut, appOut] = await Promise.all([
    smi([`--query-gpu=${GPU_FIELDS.join(",")}`, "--format=csv,noheader,nounits"]),
    smi([
      "--query-compute-apps=pid,process_name,used_memory",
      "--format=csv,noheader,nounits",
    ]),
  ]);
  const { gpus, driverVersion } = parseGpuCsv(gpuOut);
  const processes = parseComputeApps(appOut);
  await Promise.all(
    processes.map(async (p) => {
      try {
        const text = await readFile(`/proc/${p.pid}/cgroup`, "utf8");
        p.container = containerFromCgroup(text);
      } catch {
        // Process exited between the two reads, or hidepid — keep pid + name.
      }
    }),
  );
  return { gpus, processes, driverVersion };
}
