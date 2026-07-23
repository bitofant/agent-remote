// Shared helpers for the live claude-local e2e tests (`*.e2e.test.ts`). Kept
// framework-free (no vitest import) so it's just typechecked, not run as a test.
// The live tests spend zero Claude tokens — everything hits the local vLLM
// endpoint — but they ARE real model calls, so callers self-skip via `endpointUp`.
import { loadConfig } from "../config.js";
import { buildAdapters } from "./registry.js";
import type { ChatAction, ChatEvent, ChatUiRequest } from "../../shared/protocol.js";
import type { ChatSession } from "./types.js";

/** The claude-local harness under test, or null when it isn't configured. */
export interface ClaudeLocal {
  /** Build a fresh ChatSession for a cwd, optionally resuming a prior one. */
  create(cwd: string, resume?: string): ChatSession;
  /** The vLLM base URL (for the liveness probe). */
  baseUrl?: string;
}

/** Resolve the claude-local ChatSession factory from config.json, or null when
 * there's no config / it's disabled / it isn't a chat harness — so tests skip. */
export function claudeLocal(): ClaudeLocal | null {
  let config;
  try {
    config = loadConfig();
  } catch {
    return null; // No config.json (e.g. CI) — nothing to test against.
  }
  const cfg = config.harnesses.claudeLocal;
  if (!cfg?.enabled) return null;
  const adapter = buildAdapters(config).get("claude-local");
  if (!adapter?.createChatSession) return null;
  return {
    create: (cwd, resume) => adapter.createChatSession!({ cwd, resume }),
    baseUrl: cfg.env?.ANTHROPIC_BASE_URL,
  };
}

/** Probe vLLM's OpenAI-compatible /v1/models so a down endpoint skips the test
 * (via describe.skipIf) rather than hanging for the whole turn timeout. */
export async function endpointUp(baseUrl?: string): Promise<boolean> {
  if (!baseUrl) return false;
  try {
    const res = await fetch(new URL("/v1/models", baseUrl), {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reject if `p` doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      t.unref();
    }),
  ]);
}

/** Sleep helper (e.g. to let the CLI flush its transcript to disk). */
export function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thin driver over a claude-local ChatSession for tests: records every event,
 * auto-approves permission cards (so turns complete), captures the resume key,
 * and resolves each `prompt()` when its turn finishes (busy:false). */
export class ChatDriver {
  /** Every event the session emitted, in order. */
  readonly events: ChatEvent[] = [];
  /** Every `select` permission request seen (auto-approved). */
  readonly permissions: ChatUiRequest[] = [];
  /** Resume key reported by the session (SDK session id), if any. */
  resumeKey?: string;
  private turnWaiters: Array<() => void> = [];
  private condWaiters: Array<{ ok: () => boolean; resolve: () => void }> = [];

  constructor(private readonly session: ChatSession) {}

  start(): this {
    this.session.start({
      onEvent: (e) => {
        this.events.push(e);
        if (e.type === "ui-request" && e.request.kind === "select") {
          this.permissions.push(e.request);
          this.session.action({
            type: "ui-response",
            requestId: e.request.id,
            value: "Allow",
          });
        }
        // busy:false marks a whole turn done (SDK `result`).
        if (e.type === "busy" && e.busy === false) this.turnWaiters.shift()?.();
        // Fire any condition waiters whose predicate now holds.
        this.condWaiters = this.condWaiters.filter((w) => {
          if (!w.ok()) return true;
          w.resolve();
          return false;
        });
      },
      onResumable: (key) => {
        this.resumeKey = key;
      },
      onExit: () => this.turnWaiters.shift()?.(),
    });
    return this;
  }

  /** Send a prompt and resolve when the resulting turn completes (busy:false).
   * Don't use for a prompt that will BLOCK on a request you must answer from the
   * event stream (e.g. a plan) — use `send` + `waitFor` for those. */
  prompt(text: string, timeoutMs = 80_000): Promise<void> {
    const turn = new Promise<void>((resolve) => this.turnWaiters.push(resolve));
    this.session.action({ type: "prompt", text });
    return withTimeout(turn, timeoutMs, "turn did not complete in time");
  }

  /** Send a prompt without waiting for the turn to finish. */
  send(text: string): void {
    this.session.action({ type: "prompt", text });
  }

  /** Forward any action to the session (set-mode, ui-response, …). */
  act(action: ChatAction): void {
    this.session.action(action);
  }

  /** Resolve once `predicate` holds — checked immediately and after each event. */
  waitFor(
    predicate: () => boolean,
    timeoutMs = 80_000,
    message = "condition not met in time",
  ): Promise<void> {
    if (predicate()) return Promise.resolve();
    const p = new Promise<void>((resolve) =>
      this.condWaiters.push({ ok: predicate, resolve }),
    );
    return withTimeout(p, timeoutMs, message);
  }

  close(): void {
    this.session.close();
  }
}
