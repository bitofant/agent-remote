import { randomUUID } from "node:crypto";
import type { HarnessConfig } from "../config.js";
import type {
  ChatAction,
  ChatEvent,
  ChatUiRequest,
} from "../../shared/protocol.js";
import type {
  ChatTranslator,
  HarnessAdapter,
  SessionOptions,
} from "./types.js";

// Adapter for pi (https://github.com/getpi/pi). Unlike the terminal harnesses,
// pi sessions run headless via `pi --mode rpc` — a JSONL protocol over
// stdin/stdout — and render as a chat-bubble UI in the browser. This file is
// the ONLY place that knows pi's RPC vocabulary: the translator below maps it
// to/from the normalized chat schema in shared/protocol.ts.
//
// Protocol reference: the pi package's docs/rpc.md. Framing is strict JSONL
// with LF as the only delimiter (tolerate a trailing CR). Deliberately not
// Node readline, which also splits on U+2028/U+2029 — valid inside JSON
// strings.
export function createPiAdapter(cfg: HarnessConfig): HarnessAdapter {
  return {
    id: "pi",
    name: "pi",
    invocation(_opts: SessionOptions): { command: string; args: string[] } {
      return { command: cfg.command, args: ["--mode", "rpc"] };
    },
    createChatTranslator(): ChatTranslator {
      return new PiRpcTranslator();
    },
  };
}

/** Loose shape of one parsed pi RPC stdout line. Only the fields we consume
 * are typed; everything else stays unknown. */
interface PiLine {
  type?: string;
  // message_start/update/end carry an object; extension_ui_request confirm and
  // notify reuse the same field name for a string body.
  message?: { role?: string } | string;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
    toolCall?: { id?: string; name?: string; arguments?: unknown };
  };
  // tool_execution_*
  toolCallId?: string;
  toolName?: string;
  partialResult?: { content?: unknown };
  result?: { content?: unknown };
  isError?: boolean;
  // queue_update
  steering?: string[];
  followUp?: string[];
  // extension_ui_request
  id?: string;
  method?: string;
  title?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  // response
  command?: string;
  success?: boolean;
  // auto_retry_start / extension_error / compaction_end
  error?: string;
  errorMessage?: string;
  attempt?: number;
  maxAttempts?: number;
}

class PiRpcTranslator implements ChatTranslator {
  private lineBuffer = "";
  /** Whether pi is currently running an agent loop; decides whether a prompt
   * must be sent with streamingBehavior (pi rejects a bare prompt mid-run). */
  private busy = false;
  /** Whether an assistant message is currently streaming (only assistant
   * message_start/end are surfaced; user/toolResult messages are not). */
  private assistantOpen = false;

  push(chunk: string): ChatEvent[] {
    this.lineBuffer += chunk;
    const events: ChatEvent[] = [];
    for (;;) {
      const nl = this.lineBuffer.indexOf("\n");
      if (nl === -1) break;
      let line = this.lineBuffer.slice(0, nl);
      this.lineBuffer = this.lineBuffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let parsed: PiLine;
      try {
        parsed = JSON.parse(line) as PiLine;
      } catch {
        continue; // Not protocol JSON (e.g. stray debug print); skip.
      }
      events.push(...this.translate(parsed));
    }
    return events;
  }

  encode(action: ChatAction): { data: string; events: ChatEvent[] } {
    switch (action.type) {
      case "prompt": {
        const cmd = this.busy
          ? // Queue behind the current run; delivered between turns.
            { type: "prompt", message: action.text, streamingBehavior: "steer" }
          : { type: "prompt", message: action.text };
        return {
          data: `${JSON.stringify(cmd)}\n`,
          // Echo the prompt as a user bubble immediately: pi does not stream
          // user messages back over RPC.
          events: [
            {
              type: "user-message",
              message: {
                id: randomUUID(),
                role: "user",
                parts: [{ type: "text", text: action.text }],
                createdAt: Date.now(),
              },
            },
          ],
        };
      }
      case "abort":
        return { data: '{"type":"abort"}\n', events: [] };
      case "ui-response": {
        const cmd: Record<string, unknown> = {
          type: "extension_ui_response",
          id: action.requestId,
        };
        if (action.cancelled) cmd.cancelled = true;
        else if (action.confirmed !== undefined) cmd.confirmed = action.confirmed;
        else cmd.value = action.value;
        return {
          data: `${JSON.stringify(cmd)}\n`,
          // Clear the card right away; pi sends no acknowledgment.
          events: [{ type: "ui-request-done", requestId: action.requestId }],
        };
      }
      default:
        // e.g. set-model: pi's RPC supports it, but this translator does not yet
        // surface a model list to the UI, so no such action is sent. No-op.
        return { data: "", events: [] };
    }
  }

  private translate(line: PiLine): ChatEvent[] {
    switch (line.type) {
      case "agent_start":
        this.busy = true;
        return [{ type: "busy", busy: true }];
      case "agent_end":
        this.busy = false;
        this.assistantOpen = false;
        return [{ type: "busy", busy: false }];

      case "message_start":
        if (messageRole(line.message) !== "assistant") return [];
        this.assistantOpen = true;
        return [{ type: "assistant-start", messageId: randomUUID() }];
      case "message_end":
        if (messageRole(line.message) !== "assistant" || !this.assistantOpen)
          return [];
        this.assistantOpen = false;
        return [{ type: "assistant-end" }];

      case "message_update": {
        if (!this.assistantOpen) return [];
        const delta = line.assistantMessageEvent;
        switch (delta?.type) {
          case "text_start":
            return [{ type: "part-start", kind: "text" }];
          case "thinking_start":
            return [{ type: "part-start", kind: "thinking" }];
          case "text_delta":
          case "thinking_delta":
            return delta.delta
              ? [{ type: "part-delta", delta: delta.delta }]
              : [];
          case "toolcall_end": {
            const call = delta.toolCall;
            if (!call?.id) return [];
            return [
              {
                type: "tool-call",
                toolId: call.id,
                name: call.name ?? "tool",
                args: call.arguments,
              },
            ];
          }
          default:
            return [];
        }
      }

      case "tool_execution_start":
        if (!line.toolCallId) return [];
        return [{ type: "tool-update", toolId: line.toolCallId, output: "" }];
      case "tool_execution_update":
        if (!line.toolCallId) return [];
        return [
          {
            type: "tool-update",
            toolId: line.toolCallId,
            output: contentText(line.partialResult?.content),
          },
        ];
      case "tool_execution_end":
        if (!line.toolCallId) return [];
        return [
          {
            type: "tool-end",
            toolId: line.toolCallId,
            output: contentText(line.result?.content),
            isError: line.isError === true,
          },
        ];

      case "queue_update":
        return [
          {
            type: "queue",
            queued: [...(line.steering ?? []), ...(line.followUp ?? [])],
          },
        ];

      case "extension_ui_request":
        return this.translateUiRequest(line);

      case "response":
        // Command acknowledgments are uninteresting unless they failed.
        return line.success === false && line.error
          ? [{ type: "notice", level: "error", text: line.error }]
          : [];

      case "auto_retry_start":
        return [
          {
            type: "notice",
            level: "warning",
            text: `Retrying after error (attempt ${line.attempt ?? "?"}/${line.maxAttempts ?? "?"})…`,
          },
        ];
      case "extension_error":
        return [
          {
            type: "notice",
            level: "warning",
            text: `Extension error: ${line.error ?? "unknown"}`,
          },
        ];
      case "compaction_start":
        return [
          { type: "notice", level: "info", text: "Compacting context…" },
        ];
      case "compaction_end":
        return line.errorMessage
          ? [
              {
                type: "notice",
                level: "error",
                text: `Compaction failed: ${line.errorMessage}`,
              },
            ]
          : [{ type: "notice", level: "info", text: "Context compacted." }];

      default:
        return [];
    }
  }

  private translateUiRequest(line: PiLine): ChatEvent[] {
    if (!line.id) return [];
    switch (line.method) {
      case "confirm":
      case "select":
      case "input":
      case "editor": {
        const request: ChatUiRequest = {
          id: line.id,
          // pi's multi-line "editor" degrades to a plain input field.
          kind: line.method === "editor" ? "input" : line.method,
          title: line.title ?? "Agent request",
          message: typeof line.message === "string" ? line.message : undefined,
          options: line.options,
          placeholder: line.placeholder ?? line.prefill,
        };
        return [{ type: "ui-request", request }];
      }
      case "notify": {
        const level =
          line.notifyType === "warning" || line.notifyType === "error"
            ? line.notifyType
            : "info";
        const text = typeof line.message === "string" ? line.message : "";
        return text ? [{ type: "notice", level, text }] : [];
      }
      default:
        // setStatus/setWidget/setTitle/set_editor_text: fire-and-forget TUI
        // affordances with no chat equivalent.
        return [];
    }
  }
}

function messageRole(message: PiLine["message"]): string | undefined {
  return typeof message === "object" ? message?.role : undefined;
}

/** Flatten pi's tool-result content (array of text/image blocks) to text. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) =>
      block?.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
}
