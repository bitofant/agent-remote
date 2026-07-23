// Live end-to-end test of the claude-local harness (Claude CLI/SDK pointed at a
// local vLLM endpoint — see CLAUDE.md). It drives one real turn where the model
// edits a file and asserts on the backend's observable behaviour:
//   (a) an Edit triggers a permission `ui-request` (canUseTool fired), and
//   (b) the streamed tool args are parsed correctly (input_json_delta fragments
//       reassembled into a valid Edit arg object by parseToolArgs), and
//   (c) the parsed part renders through the shared renderer (cheap bonus).
//
// It spends zero Claude tokens (everything hits the local endpoint) but IS a
// live model call, so it's excluded from the fast `npm test` gate (run via
// `npm run test:e2e`) and self-skips unless claude-local is enabled and its
// endpoint answers. As with any real model call it can flake if the (small,
// local) model declines to make the requested edit — that's inherent to e2e.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { buildAdapters } from "./registry.js";
import { emptyChatState, applyChatEvent } from "../../shared/chat.js";
import { renderMessage } from "../../shared/render.js";
import type { ChatEvent, ChatUiRequest } from "../../shared/protocol.js";
import type { ChatSession } from "./types.js";

// Build the claude-local ChatSession factory + its endpoint, or null when the
// harness isn't configured (no config.json / disabled) so we skip cleanly.
function claudeLocal(): { create: () => ChatSession; baseUrl?: string } | null {
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
    create: () => adapter.createChatSession!({ cwd: DIR }),
    baseUrl: cfg.env?.ANTHROPIC_BASE_URL,
  };
}

// vLLM serves an OpenAI-compatible /v1/models; use it as a liveness probe so a
// down endpoint skips rather than hangs for the whole timeout.
async function endpointUp(baseUrl?: string): Promise<boolean> {
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

// Fresh scratch dir with a file the model will edit.
const DIR = mkdtempSync(join(tmpdir(), "agent-remote-e2e-"));
writeFileSync(join(DIR, "greeting.txt"), "hello world\n");

const local = claudeLocal();
const up = await endpointUp(local?.baseUrl);

describe.skipIf(!local || !up)("claude-local: edit a file", () => {
  it("prompts for permission and parses the edit args", async () => {
    const session = local!.create();
    const events: ChatEvent[] = [];
    let editPermission: ChatUiRequest | undefined;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.close();
        reject(new Error("timed out waiting for the edit turn to finish"));
      }, 110_000);
      timer.unref();

      session.start({
        onEvent(e) {
          events.push(e);
          // Approve every permission so the turn can complete; remember the
          // first Edit one for assertion (a).
          if (e.type === "ui-request" && e.request.kind === "select") {
            if (!editPermission && e.request.tool?.name === "Edit") {
              editPermission = e.request;
            }
            session.action({
              type: "ui-response",
              requestId: e.request.id,
              value: "Allow",
            });
          }
          // busy:false marks the whole turn done (SDK `result`).
          if (e.type === "busy" && !e.busy) {
            clearTimeout(timer);
            resolve();
          }
        },
        onExit() {
          clearTimeout(timer);
          resolve();
        },
      });

      session.action({
        type: "prompt",
        text:
          'In the file greeting.txt, use the Edit tool to replace the ' +
          'old_string "hello" with the new_string "goodbye". Make exactly ' +
          "that single edit and nothing else.",
      });
    });
    session.close();

    // (a) The Edit triggered a permission request rendered as a rich tool card.
    expect(editPermission, "no Edit permission was requested").toBeDefined();
    expect(editPermission!.kind).toBe("select");
    expect(editPermission!.tool?.name).toBe("Edit");

    // (b) The streamed tool call's args were parsed from input_json_delta
    // fragments into a well-formed Edit object (valid JSON + expected fields).
    const call = events.find(
      (e): e is Extract<ChatEvent, { type: "tool-call" }> =>
        e.type === "tool-call" && e.name === "Edit",
    );
    expect(call, "no Edit tool-call event was emitted").toBeDefined();
    const args = call!.args as Record<string, unknown>;
    expect(typeof args.file_path).toBe("string");
    expect(String(args.file_path)).toContain("greeting.txt");
    expect(typeof args.old_string).toBe("string");
    expect(typeof args.new_string).toBe("string");

    // (c) Bonus: fold the events through the shared reducer + renderer exactly
    // as the server/client do, and confirm the tool part renders the subject.
    let state = emptyChatState();
    for (const e of events) state = applyChatEvent(state, e);
    const msg = state.messages.find((m) =>
      m.parts.some((p) => p.type === "tool" && p.name === "Edit"),
    );
    expect(msg, "no message carried the Edit tool part").toBeDefined();
    expect(renderMessage(msg!).html).toContain("greeting.txt");
  });
});
