// Chat-state reducer shared by the backend and the frontend. The server folds
// adapter events into a per-session ChatState (so a connecting browser gets a
// single snapshot instead of an event log); the browser applies the identical
// reducer to live events, keeping both sides in lockstep.

import type {
  ChatEvent,
  ChatMessage,
  ChatPart,
  ChatState,
} from "./protocol.js";

/** Bounds, analogous to the terminal MAX_BUFFER: keep memory in check on
 * long-running sessions while retaining plenty of visible history. */
const MAX_MESSAGES = 200;
const MAX_TOOL_OUTPUT = 20_000;
const MAX_NOTICES = 20;

export function emptyChatState(): ChatState {
  return {
    messages: [],
    streaming: null,
    busy: false,
    pendingRequests: [],
    queued: [],
    notices: [],
    models: [],
    currentModel: null,
    modes: [],
    currentMode: null,
    commands: [],
  };
}

/** Apply one event, returning a new state object (structural sharing where
 * possible so React consumers re-render cheaply). Unknown/ill-timed events
 * are ignored rather than thrown: the stream comes from an external process. */
export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "user-message":
      return {
        ...state,
        messages: capMessages([...state.messages, event.message]),
      };

    case "busy": {
      if (event.busy) return { ...state, busy: true };
      // Going idle: flush any half-streamed assistant message into history so
      // an abort (which may skip assistant-end) never leaves it stuck.
      const messages = state.streaming
        ? capMessages([...state.messages, state.streaming])
        : state.messages;
      return { ...state, busy: false, streaming: null, queued: [], messages };
    }

    case "assistant-start":
      return {
        ...state,
        // If a previous streaming message was never closed, keep it.
        messages: state.streaming
          ? capMessages([...state.messages, state.streaming])
          : state.messages,
        streaming: {
          id: event.messageId,
          role: "assistant",
          parts: [],
          createdAt: Date.now(),
        },
      };

    case "part-start": {
      if (!state.streaming) return state;
      const part: ChatPart = { type: event.kind, text: "" };
      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: [...state.streaming.parts, part],
        },
      };
    }

    case "part-delta": {
      const msg = state.streaming;
      if (!msg) return state;
      const last = msg.parts[msg.parts.length - 1];
      if (!last || (last.type !== "text" && last.type !== "thinking"))
        return state;
      const parts = msg.parts.slice(0, -1);
      parts.push({ ...last, text: last.text + event.delta });
      return { ...state, streaming: { ...msg, parts } };
    }

    case "tool-call": {
      if (!state.streaming) return state;
      const part: ChatPart = {
        type: "tool",
        toolId: event.toolId,
        name: event.name,
        args: event.args,
        output: "",
        status: "pending",
      };
      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: [...state.streaming.parts, part],
        },
      };
    }

    case "assistant-end":
      if (!state.streaming) return state;
      return {
        ...state,
        messages: capMessages([...state.messages, state.streaming]),
        streaming: null,
      };

    case "tool-update":
      return updateToolPart(state, event.toolId, (part) => ({
        ...part,
        output: capOutput(event.output),
        status: "running",
      }));

    case "tool-end":
      return updateToolPart(state, event.toolId, (part) => ({
        ...part,
        output: capOutput(event.output),
        status: event.isError ? "error" : "done",
      }));

    case "queue":
      return { ...state, queued: event.queued };

    case "ui-request":
      return {
        ...state,
        pendingRequests: [
          ...state.pendingRequests.filter((r) => r.id !== event.request.id),
          event.request,
        ],
      };

    case "ui-request-done":
      return {
        ...state,
        pendingRequests: state.pendingRequests.filter(
          (r) => r.id !== event.requestId,
        ),
      };

    case "notice":
      return {
        ...state,
        notices: [
          ...state.notices,
          { level: event.level, text: event.text, at: Date.now() },
        ].slice(-MAX_NOTICES),
      };

    case "models":
      return { ...state, models: event.models, currentModel: event.current };

    case "model-changed":
      return { ...state, currentModel: event.current };

    case "modes":
      return { ...state, modes: event.modes, currentMode: event.current };

    case "mode-changed":
      return { ...state, currentMode: event.current };

    case "commands":
      return { ...state, commands: event.commands };
  }
}

function capMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.length > MAX_MESSAGES
    ? messages.slice(-MAX_MESSAGES)
    : messages;
}

function capOutput(output: string): string {
  return output.length > MAX_TOOL_OUTPUT
    ? output.slice(-MAX_TOOL_OUTPUT)
    : output;
}

/** Update the tool part with the given id wherever it lives — usually the
 * streaming message, but tool results can arrive after assistant-end, so
 * search finished messages from the end too. */
function updateToolPart(
  state: ChatState,
  toolId: string,
  update: (part: Extract<ChatPart, { type: "tool" }>) => ChatPart,
): ChatState {
  const patch = (msg: ChatMessage): ChatMessage | null => {
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      const part = msg.parts[i];
      if (part.type === "tool" && part.toolId === toolId) {
        const parts = [...msg.parts];
        parts[i] = update(part);
        return { ...msg, parts };
      }
    }
    return null;
  };

  if (state.streaming) {
    const patched = patch(state.streaming);
    if (patched) return { ...state, streaming: patched };
  }
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const patched = patch(state.messages[i]);
    if (patched) {
      const messages = [...state.messages];
      messages[i] = patched;
      return { ...state, messages };
    }
  }
  return state;
}
