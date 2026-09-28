import { describe, expect, it, vi } from "vitest";
import { attachModelNames, catalogKey, sanitizeModelNames } from "./modelNames.js";
import { applyChatEvent, emptyChatState } from "../shared/chat.js";
import type { ChatEvent, ChatModel, ChatState } from "../shared/protocol.js";
import type { SessionManager } from "./sessions/manager.js";
import type { HarnessAdapter } from "./adapters/types.js";

// Scripted LLM: each call pops the next reply ({} = failed call).
const llm = vi.hoisted(() => ({ replies: [] as Record<string, unknown>[], calls: 0 }));
vi.mock("./llm.js", () => ({
  llmStatus: () => ({ available: true, model: "m" }),
  suggestModelNames: async () => {
    llm.calls++;
    return llm.replies.shift() ?? {};
  },
}));

const m = (id: string, group?: string): ChatModel => ({ id, label: id, group });

// Minimal manager: one or more sessions whose state folds what the namer posts.
function fakeManager() {
  const states = new Map<string, ChatState>();
  const listeners: { onChatEvent?: (id: string, e: ChatEvent) => void }[] = [];
  const mgr = {
    subscribe(l: (typeof listeners)[number]) {
      listeners.push(l);
      return () => {};
    },
    sessionInfo: (id: string) => (states.has(id) ? { harnessId: "pi" } : undefined),
    chatState: (id: string) => states.get(id),
    postModelNames(id: string, names: Record<string, string>) {
      states.set(id, applyChatEvent(states.get(id)!, { type: "model-names", names }));
    },
  };
  const emit = (id: string, e: ChatEvent) => {
    states.set(id, applyChatEvent(states.get(id) ?? emptyChatState(), e));
    for (const l of listeners) l.onChatEvent?.(id, e);
  };
  return { mgr: mgr as unknown as SessionManager, states, emit };
}

const adapters = new Map([["pi", { llmModelNames: true } as HarnessAdapter]]);
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("attachModelNames", () => {
  it("pushes late names to every session showing the catalog, retrying a failed call", async () => {
    llm.replies = [{}, { "vllm/a": "A" }];
    llm.calls = 0;
    const { mgr, states, emit } = fakeManager();
    attachModelNames(mgr, adapters, undefined, { waitStepMs: 1, retryDelayMs: 1 });
    const models = [{ id: "vllm/a", label: "Org/a-it", group: "vllm" }];
    emit("s1", { type: "models", models, current: null });
    emit("s2", { type: "models", models, current: null });
    await settle();
    expect(llm.calls).toBe(2); // one in flight for both; the failure retried
    expect(states.get("s1")!.modelNames).toEqual({ "vllm/a": "A" });
    expect(states.get("s2")!.modelNames).toEqual({ "vllm/a": "A" });
  });
});

describe("sanitizeModelNames", () => {
  it("keeps trimmed single-line names for known ids", () => {
    expect(
      sanitizeModelNames([m("vllm/a"), m("vllm/b")], {
        "vllm/a": "  Gemma 4 ",
        "vllm/zzz": "Stray",
      }),
    ).toEqual({ "vllm/a": "Gemma 4" });
  });

  it("rejects non-strings, empty, multi-line and overlong names", () => {
    expect(
      sanitizeModelNames([m("a"), m("b"), m("c"), m("d")], {
        a: 42,
        b: "  ",
        c: "Two\nlines",
        d: "x".repeat(41),
      }),
    ).toEqual({});
  });

  it("drops both sides of a clash within a group, not across groups", () => {
    const models = [m("vllm/a", "vllm"), m("vllm/b", "vllm"), m("or/c", "or")];
    expect(
      sanitizeModelNames(models, {
        "vllm/a": "Gemma 4",
        "vllm/b": "gemma 4",
        "or/c": "Gemma 4",
      }),
    ).toEqual({ "or/c": "Gemma 4" });
  });
});

describe("catalogKey", () => {
  it("ignores order but changes with any id, label or group", () => {
    const a = m("vllm/a", "vllm");
    const b = m("vllm/b", "vllm");
    expect(catalogKey([a, b])).toBe(catalogKey([b, a]));
    expect(catalogKey([a])).not.toBe(catalogKey([a, b]));
    expect(catalogKey([a])).not.toBe(catalogKey([{ ...a, label: "x" }]));
    expect(catalogKey([a])).not.toBe(catalogKey([{ ...a, group: "or" }]));
  });
});
