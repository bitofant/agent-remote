import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../shared/protocol.js";
import type { ChatTranslator } from "./types.js";
import { createPiAdapter } from "./pi.js";

// Pure translator tests: drive pi RPC lines through `push()` and assert the
// normalized ChatEvents, with no process/tokens. Covers the retry/settle
// message types (auto_retry_end, agent_settled) and how agent_end interacts
// with a pending automatic retry.

function translator(): ChatTranslator {
  const adapter = createPiAdapter({ enabled: true, command: "pi" });
  return adapter.createChatTranslator!();
}

/** Feed one pi RPC event as a JSONL line and return the emitted ChatEvents. */
function feed(t: ChatTranslator, line: unknown): ChatEvent[] {
  return t.push(`${JSON.stringify(line)}\n`);
}

describe("pi retry / settle events", () => {
  it("surfaces a successful auto-retry as an info notice", () => {
    const t = translator();
    expect(feed(t, { type: "auto_retry_end", success: true, attempt: 2 })).toEqual([
      { type: "notice", level: "info", text: expect.stringContaining("Recovered") },
    ]);
  });

  it("surfaces a failed auto-retry as an error notice with the final error", () => {
    const t = translator();
    const events = feed(t, {
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "529 overloaded_error: Overloaded",
    });
    expect(events).toEqual([
      {
        type: "notice",
        level: "error",
        text: expect.stringContaining("529 overloaded_error: Overloaded"),
      },
    ]);
  });

  it("clears busy on agent_settled", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    expect(feed(t, { type: "agent_settled" })).toContainEqual({
      type: "busy",
      busy: false,
    });
  });

  it("keeps busy on agent_end when a retry is pending (no idle flicker)", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    const events = feed(t, { type: "agent_end", willRetry: true, messages: [] });
    expect(events).not.toContainEqual({ type: "busy", busy: false });
  });

  it("clears busy on a final agent_end (no retry pending)", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    expect(feed(t, { type: "agent_end", messages: [] })).toContainEqual({
      type: "busy",
      busy: false,
    });
  });

  it("steers a prompt sent during the retry gap (busy still held)", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    feed(t, { type: "agent_end", willRetry: true, messages: [] });
    const { data } = t.encode({ type: "prompt", text: "hi" });
    expect(data).toContain('"streamingBehavior":"steer"');
  });

  it("sends a plain prompt once the run has settled", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    feed(t, { type: "agent_end", willRetry: true, messages: [] });
    feed(t, { type: "agent_settled" });
    const { data } = t.encode({ type: "prompt", text: "hi" });
    expect(data).not.toContain("streamingBehavior");
  });
});

describe("pi text/thinking deltas", () => {
  /** Open an assistant message so message_update events are accepted. */
  function streaming(): ChatTranslator {
    const t = translator();
    feed(t, { type: "message_start", message: { role: "assistant" } });
    return t;
  }

  const update = (event: unknown) => ({
    type: "message_update",
    assistantMessageEvent: event,
  });

  it("tags a text delta with its kind", () => {
    const t = streaming();
    expect(feed(t, update({ type: "text_delta", delta: "hi" }))).toEqual([
      { type: "part-delta", kind: "text", delta: "hi" },
    ]);
  });

  it("tags a thinking delta with its kind", () => {
    const t = streaming();
    expect(feed(t, update({ type: "thinking_delta", delta: "hmm" }))).toEqual([
      { type: "part-delta", kind: "thinking", delta: "hmm" },
    ]);
  });

  it("keeps the kind on a thinking delta that trails the text part", () => {
    // pi reads a chunk's `content` before its `reasoning*` fields, so a chunk
    // straddling </think> emits text_start/text_delta and only then the
    // thinking_delta carrying the reasoning tail. The kind is what lets the
    // reducer put that tail back in the thinking part.
    const t = streaming();
    feed(t, update({ type: "text_start" }));
    feed(t, update({ type: "text_delta", delta: "\n\nPR" }));
    expect(feed(t, update({ type: "thinking_delta", delta: ".\n" }))).toEqual([
      { type: "part-delta", kind: "thinking", delta: ".\n" },
    ]);
  });
});

// --- model switcher ---------------------------------------------------------
//
// pi answers `get_available_models` / `get_state` / `set_model` as `response`
// lines. Two facts drive the shape of these tests, both observed live:
//   - responses are NOT ordered against their requests (a `get_state` came back
//     before an earlier `set_model`), so the translator must hold the current
//     model itself rather than relying on arrival order;
//   - `set_model`'s `data` IS the Model object, while `get_state`'s nests it
//     under `data.model`.

/** A pi Model object, trimmed to the fields the menu reads. */
function model(provider: string, id: string, name?: string, extra = {}) {
  return { id, name: name ?? id, provider, contextWindow: 200000, ...extra };
}

function modelsResponse(models: unknown[]) {
  return {
    type: "response",
    command: "get_available_models",
    success: true,
    data: { models },
  };
}

describe("pi model switcher", () => {
  it("asks for the model list and current state at startup", () => {
    const t = translator();
    const init = t.init!();
    expect(init).toContain('"get_available_models"');
    expect(init).toContain('"get_state"');
    // Each query is its own JSONL line.
    expect(init.trimEnd().split("\n")).toHaveLength(3);
  });

  it("maps the model list to provider-qualified menu entries", () => {
    const t = translator();
    const events = feed(
      t,
      modelsResponse([
        model("anthropic", "claude-sonnet-4-20250514", "Claude Sonnet 4"),
        model("vllm", "Qwen3.8-Flash-Next"),
      ]),
    );
    expect(events).toEqual([
      {
        type: "models",
        current: null,
        models: [
          {
            id: "anthropic/claude-sonnet-4-20250514",
            label: "Claude Sonnet 4 (anthropic)",
            description: expect.stringContaining("200K context"),
          },
          {
            id: "vllm/Qwen3.8-Flash-Next",
            label: "Qwen3.8-Flash-Next (vllm)",
            description: expect.any(String),
          },
        ],
      },
    ]);
  });

  it("keeps a model id that itself contains a slash addressable", () => {
    // Provider names never contain "/", but ids routinely do — so the composite
    // id splits at the FIRST slash only.
    const t = translator();
    const [listed] = feed(t, modelsResponse([model("baseten", "deepseek-ai/DeepSeek-V4-Pro")]));
    const id = (listed as { models: { id: string }[] }).models[0].id;
    expect(id).toBe("baseten/deepseek-ai/DeepSeek-V4-Pro");
    expect(t.encode({ type: "set-model", model: id }).data).toBe(
      `${JSON.stringify({
        type: "set_model",
        provider: "baseten",
        modelId: "deepseek-ai/DeepSeek-V4-Pro",
      })}\n`,
    );
  });

  it("reports the current model from get_state", () => {
    const t = translator();
    expect(
      feed(t, {
        type: "response",
        command: "get_state",
        success: true,
        data: { model: model("vllm", "Qwen3.8-Flash-Next"), thinkingLevel: "high" },
      }),
    ).toEqual([{ type: "model-changed", current: "vllm/Qwen3.8-Flash-Next" }]);
  });

  it("confirms a switch from set_model's own reply", () => {
    const t = translator();
    expect(
      feed(t, {
        type: "response",
        command: "set_model",
        success: true,
        data: model("vllm", "Qwen3.8-Flash-Next"),
      }),
    ).toEqual([{ type: "model-changed", current: "vllm/Qwen3.8-Flash-Next" }]);
  });

  it("surfaces a rejected switch as an error notice", () => {
    const t = translator();
    expect(
      feed(t, {
        type: "response",
        command: "set_model",
        success: false,
        error: "Model not found: vllm/nope",
      }),
    ).toEqual([
      { type: "notice", level: "error", text: "Model not found: vllm/nope" },
    ]);
  });

  it("carries the known current model into a later list response", () => {
    // The `models` fold overwrites currentModel wholesale, so a list arriving
    // after get_state must restate the current model or it would blank it.
    const t = translator();
    feed(t, {
      type: "response",
      command: "get_state",
      success: true,
      data: { model: model("vllm", "Qwen3.8-Flash-Next") },
    });
    const [listed] = feed(t, modelsResponse([model("vllm", "Qwen3.8-Flash-Next")]));
    expect(listed).toMatchObject({ current: "vllm/Qwen3.8-Flash-Next" });
  });

  it("does not let a late get_state revert a switch the user already made", () => {
    // Observed live: pi answered a get_state before an earlier set_model.
    const t = translator();
    feed(t, {
      type: "response",
      command: "set_model",
      success: true,
      data: model("vllm", "Qwen3.8-Flash-Next"),
    });
    expect(
      feed(t, {
        type: "response",
        command: "get_state",
        success: true,
        data: { model: model("vllm", "RedHatAI/gemma-4-31B-it-NVFP4") },
      }),
    ).toEqual([]);
  });

  it("confirms a switch that lands on the model already in use", () => {
    // Not deduped: the user asked and pi answered, so the menu must settle on
    // that. Only an unsolicited get_state echo is dropped.
    const t = translator();
    const reply = {
      type: "response",
      command: "set_model",
      success: true,
      data: model("vllm", "Qwen3.8-Flash-Next"),
    };
    feed(t, reply);
    expect(feed(t, reply)).toEqual([
      { type: "model-changed", current: "vllm/Qwen3.8-Flash-Next" },
    ]);
  });

  it("ignores a model entry missing its provider or id", () => {
    const t = translator();
    const [listed] = feed(t, modelsResponse([{ name: "orphan" }, model("vllm", "ok")]));
    expect((listed as { models: unknown[] }).models).toHaveLength(1);
  });
});
