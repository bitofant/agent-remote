import { describe, expect, it } from "vitest";
import { clientIp, FailureLimiter, type LimiterOptions } from "./rateLimit.js";

const OPTS: LimiterOptions = {
  freeAttempts: 3,
  baseLockMs: 1000,
  maxLockMs: 10_000,
  forgetMs: 60_000,
  maxKeys: 100,
};

function limiter(opts: Partial<LimiterOptions> = {}) {
  let t = 0;
  const l = new FailureLimiter({ ...OPTS, ...opts }, () => t);
  return { l, advance: (ms: number) => (t += ms) };
}

describe("FailureLimiter", () => {
  it("allows the free attempts, then locks", () => {
    const { l } = limiter();
    l.fail("a");
    l.fail("a");
    expect(l.retryAfterMs("a")).toBe(0);
    l.fail("a"); // 3rd = first over budget
    expect(l.retryAfterMs("a")).toBe(1000);
  });

  it("doubles the lock per further failure, capped", () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 3; i++) l.fail("a");
    const locks: number[] = [];
    for (let i = 0; i < 6; i++) {
      advance(l.retryAfterMs("a"));
      l.fail("a");
      locks.push(l.retryAfterMs("a"));
    }
    expect(locks).toEqual([2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  it("unlocks once the lock elapses", () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 3; i++) l.fail("a");
    advance(999);
    expect(l.retryAfterMs("a")).toBe(1);
    advance(1);
    expect(l.retryAfterMs("a")).toBe(0);
  });

  it("success resets the key", () => {
    const { l } = limiter();
    for (let i = 0; i < 3; i++) l.fail("a");
    l.succeed("a");
    expect(l.retryAfterMs("a")).toBe(0);
    l.fail("a");
    expect(l.retryAfterMs("a")).toBe(0);
  });

  it("keys are independent", () => {
    const { l } = limiter();
    for (let i = 0; i < 3; i++) l.fail("a");
    expect(l.retryAfterMs("b")).toBe(0);
  });

  it("forgets an idle key, restoring the free budget", () => {
    const { l, advance } = limiter();
    l.fail("a");
    l.fail("a");
    advance(60_001);
    l.fail("a");
    expect(l.retryAfterMs("a")).toBe(0);
  });

  it("never forgets a key that is still locked", () => {
    const { l, advance } = limiter({ maxLockMs: 120_000, baseLockMs: 120_000 });
    for (let i = 0; i < 3; i++) l.fail("a");
    advance(61_000); // past forgetMs, still inside the lock
    expect(l.retryAfterMs("a")).toBe(59_000);
  });

  it("bounds memory by evicting the oldest keys", () => {
    const { l } = limiter({ maxKeys: 3 });
    for (const k of ["a", "b", "c", "d"]) l.fail(k);
    expect(l.size).toBe(3);
  });
});

function req(remoteAddress: string, xff?: string | string[]) {
  return {
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  };
}

describe("clientIp", () => {
  it("uses the peer address directly", () => {
    expect(clientIp(req("203.0.113.5"))).toBe("203.0.113.5");
  });

  it("ignores X-Forwarded-For from a non-loopback peer (forgeable)", () => {
    expect(clientIp(req("203.0.113.5", "1.2.3.4"))).toBe("203.0.113.5");
  });

  it("trusts the rightmost X-Forwarded-For from a local proxy", () => {
    expect(clientIp(req("127.0.0.1", "6.6.6.6, 198.51.100.7"))).toBe(
      "198.51.100.7",
    );
    expect(clientIp(req("::1", ["6.6.6.6", "198.51.100.8"]))).toBe(
      "198.51.100.8",
    );
    expect(clientIp(req("::ffff:127.0.0.1", "198.51.100.9 "))).toBe(
      "198.51.100.9",
    );
  });

  it("falls back to the loopback peer with no header", () => {
    expect(clientIp(req("127.0.0.1"))).toBe("127.0.0.1");
  });
});
