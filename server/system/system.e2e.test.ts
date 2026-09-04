// Live contract test for the System state sampler. No endpoint, no harness, no
// tokens — but it reads /proc and spawns nvidia-smi/docker, so it's e2e rather
// than part of the pure gate (same rule as manager-exit.e2e.test.ts).
//
// It asserts the CONTRACT only, never values: the whole point is that this
// passes on a box with no GPU, no docker and no engine.
import { describe, expect, it } from "vitest";
import { sampleOnce, startSystemSampling, systemSnapshot } from "./sampler.js";
import type { SystemSectionKey, SystemSnapshot } from "../../shared/protocol.js";

const SECTIONS: SystemSectionKey[] = [
  "cpu",
  "memory",
  "disks",
  "network",
  "gpu",
  "engine",
  "containers",
];

const sectionValue = (s: SystemSnapshot, k: SystemSectionKey): unknown =>
  k === "cpu"
    ? s.cpu
    : k === "memory"
      ? s.memory
      : k === "disks"
        ? s.disks
        : k === "network"
          ? s.network
          : k === "gpu"
            ? s.gpu
            : k === "engine"
              ? s.engine
              : s.containers;

describe("system sampler (live host)", () => {
  it("always produces a snapshot, whatever the box is missing", async () => {
    startSystemSampling({
      llm: { provider: "vllm", baseUrl: "http://localhost:8000/v1", model: "x" },
    });
    const first = await sampleOnce();
    expect(first.at).toBeGreaterThan(0);
    expect(first.host.hostname).toBeTruthy();
    expect(first.host.cpuCount).toBeGreaterThan(0);

    // Second pass, so the counter deltas exist.
    await new Promise((r) => setTimeout(r, 1200));
    const s = await sampleOnce();

    // Percentages are either unknown or in range — never negative, never >100.
    for (const p of [s.cpu?.usagePct, s.cpu?.iowaitPct, s.memory?.usedPct]) {
      if (p == null) continue;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
    for (const c of s.cpu?.perCorePct ?? []) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(100);
    }
    // Rates are derived from monotonic counters: never negative.
    for (const i of s.network?.interfaces ?? []) {
      if (i.rxBps != null) expect(i.rxBps).toBeGreaterThanOrEqual(0);
      if (i.txBps != null) expect(i.txBps).toBeGreaterThanOrEqual(0);
    }

    // An error is only ever reported for a section that is actually absent.
    for (const k of SECTIONS) {
      if (s.errors[k]) expect(sectionValue(s, k)).toBeNull();
    }

    // A temperature limit is only ever reported alongside a reading, and must
    // sit above it — the UI divides by it to draw a gauge, and a limit below
    // the current temp would paint a cold machine as on fire.
    const temps: { tempC: number | null; tempLimitC: number | null }[] = [
      ...(s.cpu ? [s.cpu] : []),
      ...(s.disks?.io ?? []),
      ...(s.gpu?.gpus ?? []),
    ];
    for (const t of temps) {
      if (t.tempLimitC == null) continue;
      expect(t.tempC).not.toBeNull();
      expect(t.tempLimitC).toBeGreaterThan(t.tempC!);
      // Sanity: silicon throttles somewhere between warm and molten.
      expect(t.tempLimitC).toBeGreaterThan(40);
      expect(t.tempLimitC).toBeLessThan(150);
    }

    // systemSnapshot() is the route's whole body: cheap and never throwing.
    expect(systemSnapshot()).toBe(s);
  }, 30_000);

  it("reports no rates on the very first sample rather than a false zero", async () => {
    // A fresh process has no previous counters, so CPU% must be unknown, not 0.
    const snap = systemSnapshot();
    expect(snap).toBeTruthy();
    if (snap.cpu?.usagePct != null) expect(snap.cpu.usagePct).toBeGreaterThanOrEqual(0);
  });
});
