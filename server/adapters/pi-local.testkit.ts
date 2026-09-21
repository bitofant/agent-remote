// Shared helpers for the live pi e2e tests (`pi-*.e2e.test.ts`). Framework-free
// (no vitest import) so it's typechecked, not run as a test. These drive the
// REAL `pi --mode rpc` subprocess through the harness-agnostic SessionManager —
// exactly the production path — so they exercise the manager's resume-key
// wiring and the pi adapter's transcript replay. pi is configured to talk to a
// local vLLM endpoint (no tokens spent), so callers self-skip via `endpointUp`.
import { loadConfig } from "../config.js";
import { buildAdapters } from "./registry.js";
import { SessionManager } from "../sessions/manager.js";
import type { ChatAction, ChatEvent } from "../../shared/protocol.js";

/** The pi harness under test, or null when it isn't configured/enabled. */
export interface PiLocal {
  /** Start a pi session for a cwd (optionally resuming a prior one) and return
   * a driver over it. */
  create(cwd: string, resume?: string): PiDriver;
  /** The OpenAI-compatible base URL pi is pointed at (for the liveness probe). */
  baseUrl?: string;
}

/** Resolve the pi harness + a shared manager from config.json, or null when
 * there's no config / pi is disabled — so the e2e tests skip. */
export function piLocal(): PiLocal | null {
  let config;
  try {
    config = loadConfig();
  } catch {
    return null; // No config.json (e.g. CI) — nothing to test against.
  }
  if (!config.harnesses.pi?.enabled) return null;
  const adapters = buildAdapters(config);
  if (!adapters.get("pi")?.createChatTranslator) return null;
  const manager = new SessionManager(adapters);
  return {
    create: (cwd, resume) => new PiDriver(manager, cwd, resume),
    baseUrl: config.llm?.baseUrl,
  };
}

/** Probe the OpenAI-compatible endpoint pi uses (its `/models`) so a down
 * endpoint skips the test rather than hanging for the whole turn timeout. */
export async function endpointUp(baseUrl?: string): Promise<boolean> {
  if (!baseUrl) return false;
  try {
    const res = await fetch(new URL("models", baseUrl.replace(/\/?$/, "/")), {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Sleep helper (e.g. to let pi flush its transcript to disk before resuming). */
export function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      t.unref();
    }),
  ]);
}

/** Drives one pi session through the SessionManager: records every chat event,
 * auto-approves any permission card so turns complete, captures the resume key
 * the manager mints, and resolves each `prompt()` when its turn ends. */
export class PiDriver {
  readonly events: ChatEvent[] = [];
  /** Resume key the manager reported for this session (its pi `--session-id`). */
  resumeKey?: string;
  /** Whether, at the instant onResumable fired, the session was already
   * registered with the manager (info + folder resolvable) — i.e. the key is
   * actually persistable. Pins the fan-out ordering the DB persister relies on. */
  persistable = false;
  sessionId = "";
  private turnWaiters: Array<() => void> = [];
  private eventWaiters: Array<{
    pred: (e: ChatEvent) => boolean;
    resolve: (e: never) => void;
  }> = [];
  private unsubscribe: () => void;

  constructor(
    private readonly manager: SessionManager,
    cwd: string,
    resume?: string,
  ) {
    // Subscribe BEFORE start so we observe onResumable via the real fan-out
    // (the production index.ts persister is likewise a pre-registered global
    // listener). onResumable isn't filtered by id — one session per driver.
    this.unsubscribe = manager.subscribe({
      onStarted: () => {},
      onOutput: () => {},
      onExit: (id) => {
        if (id === this.sessionId) this.turnWaiters.shift()?.();
      },
      onResumable: (id, key) => {
        this.resumeKey = key;
        this.persistable = !!(
          manager.sessionInfo(id) && manager.sessionFolder(id)
        );
      },
      onChatEvent: (id, event) => {
        if (id !== this.sessionId) return;
        this.events.push(event);
        this.eventWaiters = this.eventWaiters.filter((w) => {
          if (!w.pred(event)) return true;
          w.resolve(event as never);
          return false;
        });
        if (event.type === "ui-request" && event.request.kind === "select") {
          this.manager.chatAction(this.sessionId, {
            type: "ui-response",
            requestId: event.request.id,
            value: event.request.options?.[0]?.value ?? "Allow",
          });
        }
        if (event.type === "busy" && event.busy === false)
          this.turnWaiters.shift()?.();
      },
    });
    this.sessionId = manager.start("pi", { cwd, resume }).id;
  }

  /** Send a prompt; resolve when the resulting turn completes (busy:false). */
  prompt(text: string, timeoutMs = 90_000): Promise<void> {
    const turn = new Promise<void>((resolve) => this.turnWaiters.push(resolve));
    this.manager.chatAction(this.sessionId, { type: "prompt", text });
    return withTimeout(turn, timeoutMs, "pi turn did not complete in time");
  }

  act(action: ChatAction): void {
    this.manager.chatAction(this.sessionId, action);
  }

  /** Resolve with the first chat event matching `pred` — including ones already
   * received, since a reply to pi's startup handshake can land before a test
   * gets to wait for it. */
  waitFor<T extends ChatEvent>(
    pred: (e: ChatEvent) => e is T,
    timeoutMs = 20_000,
  ): Promise<T> {
    const seen = this.events.find(pred);
    if (seen) return Promise.resolve(seen);
    return withTimeout(
      new Promise<T>((resolve) => this.eventWaiters.push({ pred, resolve })),
      timeoutMs,
      "pi did not emit the awaited event in time",
    );
  }

  close(): void {
    this.manager.stop(this.sessionId);
    this.unsubscribe();
  }
}
