import type { IncomingMessage } from "node:http";

// Brute-force throttling for the auth routes. Pure (injectable clock), no I/O.

export interface LimiterOptions {
  /** Failures allowed before any lockout. */
  freeAttempts: number;
  /** First lockout; doubles with every further failure. */
  baseLockMs: number;
  maxLockMs: number;
  /** An idle, unlocked key is forgotten after this long. */
  forgetMs: number;
  /** Memory bound: oldest keys are evicted past this. */
  maxKeys: number;
}

interface Entry {
  failures: number;
  lockedUntil: number;
  last: number;
}

export class FailureLimiter {
  private entries = new Map<string, Entry>();

  constructor(
    private opts: LimiterOptions,
    private now: () => number = Date.now,
  ) {}

  /** 0 when `key` may attempt now, else ms until it may. */
  retryAfterMs(key: string): number {
    const e = this.live(key);
    return e ? Math.max(0, e.lockedUntil - this.now()) : 0;
  }

  /** Record a failure. Callers record BEFORE the (async) check so a parallel
   * burst can't all slip past the lock, then `succeed` on a good result. */
  fail(key: string): void {
    const now = this.now();
    const e = this.live(key) ?? { failures: 0, lockedUntil: 0, last: now };
    e.failures++;
    e.last = now;
    const over = e.failures - this.opts.freeAttempts;
    if (over >= 0) {
      const lock = Math.min(
        this.opts.baseLockMs * 2 ** Math.min(over, 30),
        this.opts.maxLockMs,
      );
      e.lockedUntil = now + lock;
    }
    this.entries.delete(key); // re-insert: Map order = recency, for eviction
    this.entries.set(key, e);
    this.evict();
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private live(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (e && this.expired(e)) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  private expired(e: Entry): boolean {
    const now = this.now();
    return e.lockedUntil <= now && now - e.last > this.opts.forgetMs;
  }

  private evict(): void {
    if (this.entries.size <= this.opts.maxKeys) return;
    for (const [k, e] of this.entries) if (this.expired(e)) this.entries.delete(k);
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.opts.maxKeys) break;
      this.entries.delete(k);
    }
  }
}

function isLoopback(addr: string): boolean {
  return (
    addr === "::1" ||
    addr.startsWith("127.") ||
    addr.startsWith("::ffff:127.")
  );
}

/** Client address for throttling. `X-Forwarded-For` is honoured only from a
 * loopback peer (a local reverse proxy/tunnel) — from anyone else it's forgeable.
 * Rightmost entry = what our proxy saw; leftmost ones are client-supplied. */
export function clientIp(
  req: Pick<IncomingMessage, "headers"> & {
    socket: { remoteAddress?: string };
  },
): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (!isLoopback(peer)) return peer;
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : xff;
  const last = raw
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  return last ?? peer;
}
