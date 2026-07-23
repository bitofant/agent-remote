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
import { emptyChatState, applyChatEvent } from "../../shared/chat.js";
import { renderMessage } from "../../shared/render.js";
import type { ChatEvent } from "../../shared/protocol.js";
import { claudeLocal, endpointUp, ChatDriver } from "./claude-local.testkit.js";

// Fresh scratch dir with a file the model will edit.
const DIR = mkdtempSync(join(tmpdir(), "agent-remote-e2e-"));
writeFileSync(join(DIR, "greeting.txt"), "hello world\n");

const local = claudeLocal();
const up = await endpointUp(local?.baseUrl);

describe.skipIf(!local || !up)("claude-local: edit a file", () => {
  it("prompts for permission and parses the edit args", async () => {
    const driver = new ChatDriver(local!.create(DIR)).start();
    await driver.prompt(
      'In the file greeting.txt, use the Edit tool to replace the ' +
        'old_string "hello" with the new_string "goodbye". Make exactly ' +
        "that single edit and nothing else.",
      110_000,
    );
    driver.close();

    // (a) The Edit triggered a permission request rendered as a rich tool card.
    const editPermission = driver.permissions.find((r) => r.tool?.name === "Edit");
    expect(editPermission, "no Edit permission was requested").toBeDefined();
    expect(editPermission!.kind).toBe("select");

    // (b) The streamed tool call's args were parsed from input_json_delta
    // fragments into a well-formed Edit object (valid JSON + expected fields).
    const call = driver.events.find(
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
    for (const e of driver.events) state = applyChatEvent(state, e);
    const msg = state.messages.find((m) =>
      m.parts.some((p) => p.type === "tool" && p.name === "Edit"),
    );
    expect(msg, "no message carried the Edit tool part").toBeDefined();
    expect(renderMessage(msg!).html).toContain("greeting.txt");
  }, 170_000);
});
