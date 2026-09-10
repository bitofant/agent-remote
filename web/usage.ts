import type { ChatUsageWindow } from "../shared/protocol.js";

/** How far through a rate-limit window we are, 0–100, or null when the harness
 * didn't report enough to say (no reset time, or no window length).
 *
 * Paired with a window's `utilization` this is the whole point of the pace
 * marker: 60% used at 30% elapsed is burning too fast, at 90% elapsed it's
 * fine. Clamped, so a stale snapshot whose window already reset reads 100 (and
 * a clock skew reads 0) rather than drawing the tick outside the track. */
export function windowElapsedPct(
  w: ChatUsageWindow,
  now = Date.now(),
): number | null {
  if (!w.resetsAt || w.windowMs === null || w.windowMs <= 0) return null;
  const resets = new Date(w.resetsAt).getTime();
  if (Number.isNaN(resets)) return null;
  const remaining = resets - now;
  return clampPct(100 * (1 - remaining / w.windowMs));
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}
