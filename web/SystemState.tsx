// The System state page: host / GPU / LLM-engine / docker telemetry.
//
// Folder-independent (it's about the box, not a project), read-only, and
// polled. Every section renders even when its data is null — a box with no GPU
// or no docker shows the card with the reason in it, so the page never looks
// broken on a machine that simply lacks the hardware.
import { useEffect, useRef, useState } from "react";
import type {
  ContainerInfo,
  GpuSection,
  SystemSnapshot,
} from "../shared/protocol";

/** Matches the server's sampling tick; the GET also keeps that sampler alive. */
const POLL_MS = 2000;

// --- formatting -------------------------------------------------------------

/** An em dash, not "0": a null means "we don't know yet" (first sample, or a
 * counter reset), and printing 0% idle CPU would be a lie. */
const DASH = "—";

const pct = (n: number | null | undefined, digits = 0) =>
  n == null ? DASH : `${n.toFixed(digits)}%`;

function bytes(n: number | null | undefined): string {
  if (n == null) return DASH;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const kb = (n: number | null | undefined) => (n == null ? DASH : bytes(n * 1024));

const rate = (n: number | null | undefined) =>
  n == null ? DASH : `${bytes(n)}/s`;

const count = (n: number | null | undefined) =>
  n == null ? DASH : n.toLocaleString();

function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const tokens = (n: number | null | undefined) =>
  n == null ? DASH : `${n.toFixed(n < 10 ? 1 : 0)} tok/s`;

const temp = (n: number | null | undefined) =>
  n == null ? DASH : `${n.toFixed(0)}°C`;

// --- primitives -------------------------------------------------------------

/**
 * Usage meter. `tone="load"` (the default) warns at 75% and goes danger at 90%
 * — one place decides colour, so every bar agrees. `tone="plain"` never colours:
 * it's for metrics where a high number is GOOD (cache hit rate), which would
 * otherwise render as alarming red exactly when things are going well.
 */
function Bar({
  value,
  tone = "load",
}: {
  value: number | null;
  tone?: "load" | "plain";
}) {
  const v = value == null ? 0 : Math.min(100, Math.max(0, value));
  const level = tone === "plain" ? "" : v >= 90 ? "hot" : v >= 75 ? "warn" : "";
  return (
    <div className="system-bar">
      <div className={`system-bar-fill ${level}`} style={{ width: `${v}%` }} />
    </div>
  );
}

function Row({
  label,
  value,
  title,
}: {
  label: string;
  value: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="system-row" title={title}>
      <span className="system-row-label">{label}</span>
      <span className="system-row-value">{value}</span>
    </div>
  );
}

/** A metric with its own meter underneath. */
function Meter({
  label,
  value,
  percent,
  tone,
  title,
}: {
  label: string;
  value: React.ReactNode;
  percent: number | null;
  tone?: "load" | "plain";
  title?: string;
}) {
  return (
    <div className="system-meter">
      <Row label={label} value={value} title={title} />
      <Bar value={percent} tone={tone} />
    </div>
  );
}

/** Percentage of a ceiling, or null when either side is unknown — so a gauge
 * is only ever drawn against a real scale. */
const ratio = (
  value: number | null | undefined,
  limit: number | null | undefined,
): number | null =>
  value == null || limit == null || limit <= 0 ? null : (value / limit) * 100;

/**
 * A temperature gauge, but only where the sensor publishes its own throttle
 * point; otherwise a plain reading. Inventing a ceiling (say "GPUs die at
 * 100°C") would put the warn/danger colours at an arbitrary place — k10temp
 * exposes no limit at all on some boards, so this really does vary by machine.
 */
function TempMeter({
  label,
  tempC,
  limitC,
}: {
  label: string;
  tempC: number | null;
  limitC: number | null;
}) {
  const value = temp(tempC);
  if (tempC == null || limitC == null) return <Row label={label} value={value} />;
  return (
    <Meter
      label={label}
      value={`${value} / ${temp(limitC)}`}
      percent={ratio(tempC, limitC)}
      title={`Throttles at ${temp(limitC)}`}
    />
  );
}

function Card({
  title,
  error,
  children,
}: {
  title: string;
  error?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="system-card">
      <label className="field-label">{title}</label>
      {error ? <p className="muted">{error}</p> : children}
    </section>
  );
}

// --- polling ----------------------------------------------------------------

function useSystemSnapshot() {
  const [snap, setSnap] = useState<SystemSnapshot | null>(null);
  const [stale, setStale] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    const tick = () => {
      // Paused while backgrounded: no point sampling a page nobody can see,
      // and the server stops its own sampler once the GETs stop.
      if (document.hidden) return;
      fetch("/api/system")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((s: SystemSnapshot) => {
          if (cancelled.current) return;
          setSnap(s);
          setStale(false);
        })
        // Keep the last frame rather than blanking the page on one bad poll.
        .catch(() => !cancelled.current && setStale(true));
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    // Refetch the moment we come back, instead of waiting out the interval.
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled.current = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  return { snap, stale };
}

// --- cards ------------------------------------------------------------------

function SystemCard({ snap }: { snap: SystemSnapshot }) {
  const { cpu, memory, host } = snap;
  const err = snap.errors.cpu ?? snap.errors.memory;
  return (
    <Card title="System usage" error={cpu || memory ? undefined : err}>
      {cpu && (
        <>
          <Meter label="CPU" value={pct(cpu.usagePct, 1)} percent={cpu.usagePct} />
          {cpu.perCorePct.length > 0 && (
            <div className="system-cores" title={`${cpu.perCorePct.length} logical cores`}>
              {cpu.perCorePct.map((c, i) => (
                <div key={i} className="system-core">
                  <div
                    className={`system-core-fill ${c >= 90 ? "hot" : c >= 75 ? "warn" : ""}`}
                    style={{ height: `${Math.max(2, Math.min(100, c))}%` }}
                  />
                </div>
              ))}
            </div>
          )}
          <Row label="User / system" value={`${pct(cpu.userPct, 1)} / ${pct(cpu.systemPct, 1)}`} />
          <Row label="I/O wait" value={pct(cpu.iowaitPct, 1)} />
          {cpu.tempC != null && (
            <TempMeter label="CPU temp" tempC={cpu.tempC} limitC={cpu.tempLimitC} />
          )}
        </>
      )}
      {memory && (
        <>
          <Meter
            label="Memory"
            value={`${kb(memory.totalKb - memory.availableKb)} / ${kb(memory.totalKb)}`}
            percent={memory.usedPct}
          />
          <Row label="Available" value={kb(memory.availableKb)} />
          <Row label="Cached" value={kb(memory.cachedKb)} />
          {memory.swapTotalKb > 0 && (
            <Meter
              label="Swap"
              value={`${kb(memory.swapTotalKb - memory.swapFreeKb)} / ${kb(memory.swapTotalKb)}`}
              percent={ratio(
                memory.swapTotalKb - memory.swapFreeKb,
                memory.swapTotalKb,
              )}
            />
          )}
        </>
      )}
      {/* Load is only meaningful against the core count: 24.0 on this box is
          saturation, on a 2-core VM it's a meltdown. */}
      <Meter
        label="Load (1m)"
        value={host.loadAvg.map((l) => l.toFixed(2)).join("  ")}
        percent={ratio(host.loadAvg[0], host.cpuCount)}
        title={`1 / 5 / 15 min, across ${host.cpuCount} threads`}
      />
      <Row label="Uptime" value={duration(host.uptimeSec)} />
      <Row label="Host" value={host.hostname} title={`${host.platform} ${host.release}`} />
      {host.cpuModel && (
        <div className="system-sub">
          {host.cpuModel} · {host.cpuCount} threads
        </div>
      )}
    </Card>
  );
}

function GpuCard({ gpu, error }: { gpu: GpuSection | null; error?: string }) {
  return (
    <Card title="GPU usage" error={gpu ? undefined : (error ?? "No GPU detected.")}>
      {gpu?.gpus.length === 0 && <p className="muted">No GPUs reported.</p>}
      {gpu?.gpus.map((g) => (
        <div key={g.index} className="system-group">
          <div className="system-group-title">
            {g.index}: {g.name}
          </div>
          <Meter label="Utilization" value={pct(g.utilizationPct)} percent={g.utilizationPct} />
          <Meter
            label="VRAM"
            value={`${bytes((g.memoryUsedMb ?? 0) * 1024 ** 2)} / ${bytes((g.memoryTotalMb ?? 0) * 1024 ** 2)}`}
            percent={
              g.memoryUsedMb != null && g.memoryTotalMb
                ? (g.memoryUsedMb / g.memoryTotalMb) * 100
                : null
            }
          />
          {/* Memory *bandwidth*, not occupancy — the VRAM meter above is how
              full it is, this is how hard the bus is working. */}
          <Meter
            label="Memory bus"
            value={pct(g.memoryUtilPct)}
            percent={g.memoryUtilPct}
            title="Share of time the memory interface was busy"
          />
          {g.powerLimitWatts ? (
            <Meter
              label="Power"
              value={`${g.powerWatts == null ? DASH : `${g.powerWatts.toFixed(0)} W`} / ${g.powerLimitWatts.toFixed(0)} W`}
              percent={ratio(g.powerWatts, g.powerLimitWatts)}
            />
          ) : (
            <Row
              label="Power"
              value={g.powerWatts == null ? DASH : `${g.powerWatts.toFixed(0)} W`}
            />
          )}
          <TempMeter label="Temp" tempC={g.tempC} limitC={g.tempLimitC} />
          {g.fanPct != null && (
            <Meter label="Fan" value={pct(g.fanPct)} percent={g.fanPct} />
          )}
          {g.clockSmMaxMhz ? (
            <Meter
              label="SM clock"
              value={`${g.clockSmMhz ?? DASH} / ${g.clockSmMaxMhz} MHz`}
              percent={ratio(g.clockSmMhz, g.clockSmMaxMhz)}
              tone="plain"
              title="Clock relative to this card's maximum"
            />
          ) : (
            <Row
              label="Clocks"
              value={
                g.clockSmMhz == null
                  ? DASH
                  : `${g.clockSmMhz} MHz SM · ${g.clockMemMhz ?? DASH} MHz mem`
              }
            />
          )}
        </div>
      ))}
      {gpu && (
        <div className="system-group">
          <div className="system-group-title">Processes</div>
          {gpu.processes.length === 0 ? (
            <p className="muted">No compute processes.</p>
          ) : (
            gpu.processes.map((p) => (
              <div key={p.pid} className="system-item">
                <Row
                  label={p.name}
                  value={bytes((p.usedMemoryMb ?? 0) * 1024 ** 2)}
                  title={`pid ${p.pid}`}
                />
                <div className="system-sub">
                  pid {p.pid}
                  {p.container ? ` · ${p.container}` : ""}
                </div>
              </div>
            ))
          )}
        </div>
      )}
      {gpu?.driverVersion && <div className="system-sub">Driver {gpu.driverVersion}</div>}
    </Card>
  );
}

function EngineCard({ snap }: { snap: SystemSnapshot }) {
  const e = snap.engine;
  // A configured-but-down engine is worth showing as a card with its reason,
  // not as an empty section: "nothing answering" is the useful signal.
  if (!e || !e.reachable) {
    return (
      <Card title="LLM usage">
        <div className="system-badge muted-badge">
          {e?.detection === "remote" ? "Remote endpoint" : "Not detected"}
        </div>
        <p className="muted">
          {e?.detail ?? snap.errors.engine ?? "No engine reachable."}
        </p>
        {e && <Row label="Endpoint" value={<code>{e.baseUrl}</code>} />}
        {e?.container && <Row label="Container" value={e.container} />}
      </Card>
    );
  }
  const flavour =
    e.flavour === "vllm" ? "vLLM" : e.flavour === "llamacpp" ? "llama.cpp" : "Unknown engine";
  return (
    <Card title="LLM usage">
      <div className="system-badge ok-badge">{flavour}</div>
      {e.model && <Row label="Model" value={<code>{e.model}</code>} title={e.model} />}
      {e.maxModelLen != null && <Row label="Context" value={count(e.maxModelLen)} />}
      {e.container && <Row label="Container" value={e.container} />}
      <Row label="Endpoint" value={<code>{e.baseUrl}</code>} />
      {e.detection === "local-metrics" ? (
        <>
          <Row label="Running" value={count(e.requestsRunning)} />
          <Row
            label="Queued"
            value={count(e.requestsWaiting)}
            title="Requests waiting for a slot"
          />
          {e.kvCacheUsedPct != null && (
            <Meter label="KV cache" value={pct(e.kvCacheUsedPct, 1)} percent={e.kvCacheUsedPct} />
          )}
          <Row label="Generation" value={tokens(e.generationTokensPerSec)} />
          <Row label="Prompt" value={tokens(e.promptTokensPerSec)} />
          {e.timeToFirstTokenMs != null && (
            <Row label="TTFT" value={`${e.timeToFirstTokenMs.toFixed(0)} ms`} />
          )}
          {/* Hit rate: high is GOOD, so it must not colour like a load gauge. */}
          {e.prefixCacheHitPct != null && (
            <Meter
              label="Prefix cache"
              value={pct(e.prefixCacheHitPct, 1)}
              percent={e.prefixCacheHitPct}
              tone="plain"
              title="Share of prompt tokens served from cache"
            />
          )}
          {e.preemptionsTotal != null && (
            <Row label="Preemptions" value={count(e.preemptionsTotal)} />
          )}
          <div className="system-sub">
            {count(e.generationTokensTotal)} tokens generated since start
          </div>
        </>
      ) : (
        <p className="muted">Endpoint is up but exposes no metrics.</p>
      )}
    </Card>
  );
}

function ContainerRow({ c }: { c: ContainerInfo }) {
  const memPct =
    c.memUsedBytes != null && c.memLimitBytes
      ? (c.memUsedBytes / c.memLimitBytes) * 100
      : null;
  return (
    <div className="system-item">
      <Row
        label={c.name}
        value={`${pct(c.cpuPct, 1)} · ${bytes(c.memUsedBytes)}`}
        title={c.image}
      />
      {memPct != null && <Bar value={memPct} />}
      <div className="system-sub">
        {c.status}
        {c.ports.length > 0 ? ` · ${c.ports.filter((p) => p.includes("0.0.0.0")).join(", ") || c.ports[0]}` : ""}
      </div>
    </div>
  );
}

function DockerCard({ snap }: { snap: SystemSnapshot }) {
  const c = snap.containers;
  const stale =
    c?.statsAt != null && snap.at - c.statsAt > 30_000
      ? "CPU/memory figures are stale."
      : null;
  return (
    <Card title="Docker" error={c ? undefined : snap.errors.containers}>
      {c?.containers.length === 0 && <p className="muted">No running containers.</p>}
      {c?.containers.map((x) => (
        <ContainerRow key={x.id} c={x} />
      ))}
      {stale && <div className="system-sub">{stale}</div>}
    </Card>
  );
}

function DiskCard({ snap }: { snap: SystemSnapshot }) {
  const d = snap.disks;
  return (
    <Card title="Disk" error={d ? undefined : snap.errors.disks}>
      {d?.mounts.map((m) => (
        <Meter
          key={m.mount}
          label={m.mount}
          value={`${bytes(m.totalBytes - m.freeBytes)} / ${bytes(m.totalBytes)}`}
          percent={m.usedPct}
        />
      ))}
      {d && d.io.length > 0 && (
        <div className="system-group">
          <div className="system-group-title">Activity</div>
          {d.io.map((io) => (
            <div key={io.device} className="system-item">
              <Meter
                label={io.device}
                value={`↓ ${rate(io.readBps)} · ↑ ${rate(io.writeBps)}`}
                percent={io.utilPct}
                title="Share of time the device had I/O in flight"
              />
              <div className="system-sub">
                busy {pct(io.utilPct)}
                {io.tempC != null
                  ? ` · ${temp(io.tempC)}${io.tempLimitC != null ? ` of ${temp(io.tempLimitC)}` : ""}`
                  : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function NetworkCard({ snap }: { snap: SystemSnapshot }) {
  const n = snap.network;
  return (
    <Card title="Network" error={n ? undefined : snap.errors.network}>
      {n?.interfaces.length === 0 && <p className="muted">No interfaces.</p>}
      {n?.interfaces.map((i) => (
        <div key={i.name} className="system-item">
          <Row label={i.name} value={`↓ ${rate(i.rxBps)} · ↑ ${rate(i.txBps)}`} />
          <div className="system-sub">
            {bytes(i.rxBytes)} in · {bytes(i.txBytes)} out
          </div>
        </div>
      ))}
    </Card>
  );
}

// --- page -------------------------------------------------------------------

export default function SystemState() {
  const { snap, stale } = useSystemSnapshot();
  const [now, setNow] = useState(Date.now());

  // Drives the "updated Ns ago" label between polls.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const age = snap?.at ? Math.max(0, Math.round((now - snap.at) / 1000)) : null;

  return (
    <div className="system-view">
      <div className="folder-header">
        <span className="folder-header-path">System state</span>
        <span className="system-status">
          {stale ? "reconnecting…" : age == null ? "" : `updated ${age}s ago`}
        </span>
      </div>
      {!snap ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="system-page">
          <SystemCard snap={snap} />
          <GpuCard gpu={snap.gpu} error={snap.errors.gpu} />
          <EngineCard snap={snap} />
          <DockerCard snap={snap} />
          <DiskCard snap={snap} />
          <NetworkCard snap={snap} />
        </div>
      )}
    </div>
  );
}
