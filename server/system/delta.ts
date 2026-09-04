// Counter → rate maths for the System state page. Pure: no I/O, no clock reads.
//
// Everything the page shows as a rate (CPU %, tok/s, B/s) comes from a
// monotonic counter sampled twice. Those counters reset — a reboot, an engine
// restart, `docker restart`, an interface bounce, a device disappearing — so
// the one rule here is that a *decreasing* counter yields null rather than a
// negative or a multi-GB/s spike. Callers reseed and recover on the next tick.

/** One `/proc/stat` cpu line, in jiffies. */
export interface CpuTicks {
  /** "cpu" for the aggregate, "cpu0".. per core. */
  name: string;
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

export interface CpuBreakdown {
  usagePct: number;
  userPct: number;
  systemPct: number;
  iowaitPct: number;
}

const clampPct = (n: number) => Math.min(100, Math.max(0, n));

/** Rate per second, or null when there's no previous sample, the counter went
 * backwards, or no time passed. Never negative. */
export function rateOf(
  prev: number | null | undefined,
  next: number | null | undefined,
  dtMs: number,
): number | null {
  if (prev == null || next == null) return null;
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return null;
  if (dtMs <= 0) return null;
  if (next < prev) return null; // counter reset
  return ((next - prev) * 1000) / dtMs;
}

const total = (t: CpuTicks) =>
  t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal;

/** CPU busy share between two `/proc/stat` samples of the SAME line. Null when
 * the totals didn't advance (or went backwards). */
export function cpuPercent(
  prev: CpuTicks | null | undefined,
  next: CpuTicks | null | undefined,
): CpuBreakdown | null {
  if (!prev || !next) return null;
  const totalDelta = total(next) - total(prev);
  if (totalDelta <= 0) return null;
  const idleDelta = next.idle - prev.idle + (next.iowait - prev.iowait);
  const pct = (d: number) => clampPct((d / totalDelta) * 100);
  return {
    usagePct: clampPct(((totalDelta - idleDelta) / totalDelta) * 100),
    userPct: pct(next.user - prev.user + (next.nice - prev.nice)),
    systemPct: pct(next.system - prev.system),
    iowaitPct: pct(next.iowait - prev.iowait),
  };
}

/** Mean of a Prometheus histogram over a window, from its _sum/_count deltas.
 * Null when no observations landed in the window — the all-time mean would be
 * a lie, and 0 would read as "instant". */
export function histogramAvg(
  prevSum: number | null | undefined,
  prevCount: number | null | undefined,
  nextSum: number | null | undefined,
  nextCount: number | null | undefined,
): number | null {
  if (prevSum == null || prevCount == null) return null;
  if (nextSum == null || nextCount == null) return null;
  const dCount = nextCount - prevCount;
  const dSum = nextSum - prevSum;
  if (dCount <= 0 || dSum < 0) return null;
  return dSum / dCount;
}
