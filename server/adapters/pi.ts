import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

// Adapter for pi (https://github.com/getpi/pi): runs headless via `pi --mode
// rpc` (JSONL over stdin/stdout), rendered as chat bubbles. The ONLY place that
// knows pi's RPC vocabulary; the translator maps it to/from the chat schema.
// Protocol ref: pi's docs/rpc.md. Framing is strict JSONL, LF-delimited
// (tolerate trailing CR). NOT Node readline — it also splits on U+2028/U+2029,
// valid inside JSON strings.
export function createPiAdapter(cfg: HarnessConfig): HarnessAdapter {
  return {
    id: "pi",
    name: "pi",
    // pi resumes via a caller-chosen `--session-id`: the session layer mints one
    // (also our resume key) and threads it in through `opts.resume`.
    resumable: true,
    invocation(opts: SessionOptions): { command: string; args: string[] } {
      const args = ["--mode", "rpc"];
      // `--session-id` creates the session if missing and reloads it (restoring
      // context) when it already exists — same flag for fresh and resumed runs.
      if (opts.resume) args.push("--session-id", opts.resume);
      return { command: cfg.command, args };
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
  data?: { commands?: { name?: string; description?: string }[] };
  // auto_retry_start / auto_retry_end / extension_error / compaction_end
  error?: string;
  errorMessage?: string;
  attempt?: number;
  maxAttempts?: number;
  finalError?: string;
  // agent_end: an automatic retry (transient error / overflow compaction) is
  // about to follow, so the run isn't finished — keep busy held until settled.
  willRetry?: boolean;
}

class PiRpcTranslator implements ChatTranslator {
  private lineBuffer = "";
  /** Whether pi is currently running an agent loop; decides whether a prompt
   * must be sent with streamingBehavior (pi rejects a bare prompt mid-run).
   * Held from agent_start until agent_settled (NOT the earlier agent_end, which
   * may be followed by an automatic retry / compaction / queued continuation),
   * so the busy indicator doesn't flicker to idle mid-run. */
  private busy = false;
  /** Whether an assistant message is currently streaming (only assistant
   * message_start/end are surfaced; user/toolResult messages are not). */
  private assistantOpen = false;

  /** Query the available slash commands (extension commands, prompt templates,
   * skills) once at startup so the UI can offer a `/` palette. */
  init(): string {
    return '{"type":"get_commands"}\n';
  }

  /** Rebuild a resumed conversation from pi's on-disk session JSONL — the RPC
   * stream doesn't replay history on `--session-id` reload. Best-effort: any
   * read/parse failure yields an empty transcript (context is still restored). */
  async replayHistory(opts: SessionOptions): Promise<ChatEvent[]> {
    if (!opts.resume) return [];
    return readPiSessionHistory(opts.cwd, opts.resume);
  }

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
      case "agent_end": {
        // One low-level run finished; its assistant message is closed. But if a
        // retry is queued, the loop continues — stay busy so the UI doesn't drop
        // to idle between the failure and the retry.
        this.assistantOpen = false;
        if (line.willRetry) return [];
        this.busy = false;
        return [{ type: "busy", busy: false }];
      }
      case "agent_settled":
        // Authoritative end of the whole run (no retry/compaction/queue left).
        // Idempotent with agent_end; also the safety net that guarantees busy
        // clears even after a retry or compaction continuation.
        this.busy = false;
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
        // get_commands reply → surface the slash-command palette.
        if (line.command === "get_commands" && line.data?.commands) {
          return [
            {
              type: "commands",
              commands: line.data.commands
                .filter((c): c is { name: string; description?: string } =>
                  typeof c.name === "string" && c.name.length > 0,
                )
                .map((c) => ({ name: c.name, description: c.description })),
            },
          ];
        }
        // Other command acknowledgments are uninteresting unless they failed.
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
      case "auto_retry_end":
        // A retry either recovered or gave up after max attempts. Surface both
        // so a run that silently died after retries isn't a mystery.
        return line.success
          ? [
              {
                type: "notice",
                level: "info",
                text: `Recovered after retry (attempt ${line.attempt ?? "?"}).`,
              },
            ]
          : [
              {
                type: "notice",
                level: "error",
                text: `Retry failed after ${line.attempt ?? "?"} attempt(s): ${line.finalError ?? "unknown error"}`,
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

// --- resume: read pi's on-disk session transcript ---------------------------

/** One persisted content block inside a pi session `message` line. */
interface PiStoredBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}
/** One persisted `message` line in a pi session JSONL file. */
interface PiStoredMessage {
  type?: string;
  message?: {
    role?: string;
    content?: PiStoredBlock[];
    // toolResult lines carry the linkage/result at the message level.
    toolCallId?: string;
    isError?: boolean;
  };
}

/** Root of pi's session store (project subdirs live under here). */
function piSessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/** pi mangles a project cwd into a session subdir name: `--` + path segments
 * joined by `-` + `--` (e.g. `/tmp/x-y` → `--tmp-x-y--`). */
function mangleCwd(cwd: string): string {
  return `--${cwd.split("/").filter(Boolean).join("-")}--`;
}

/** Locate the JSONL file for a session id: try the mangled project subdir
 * first, then fall back to scanning every subdir (ids are UUIDs — unique). */
function findSessionFile(cwd: string, sessionId: string): string | undefined {
  const root = piSessionsRoot();
  const suffix = `_${sessionId}.jsonl`;
  const inDir = (dir: string): string | undefined => {
    try {
      const name = readdirSync(dir).find((f) => f.endsWith(suffix));
      return name ? join(dir, name) : undefined;
    } catch {
      return undefined;
    }
  };
  const preferred = inDir(join(root, mangleCwd(cwd)));
  if (preferred) return preferred;
  let subdirs: string[];
  try {
    subdirs = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const sub of subdirs) {
    const hit = inDir(join(root, sub));
    if (hit) return hit;
  }
  return undefined;
}

/** Parse a pi session file into normalized chat events, folding whole stored
 * messages through the same event vocabulary the live stream produces so
 * replayed bubbles match freshly-streamed ones. */
function readPiSessionHistory(cwd: string, sessionId: string): ChatEvent[] {
  const file = findSessionFile(cwd, sessionId);
  if (!file) return [];
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
  const events: ChatEvent[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    let entry: PiStoredMessage;
    try {
      entry = JSON.parse(raw) as PiStoredMessage;
    } catch {
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    const content = Array.isArray(msg.content) ? msg.content : [];
    if (msg.role === "user") {
      const text = content
        .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
        .join("");
      if (text)
        events.push({
          type: "user-message",
          message: {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text }],
            createdAt: Date.now(),
          },
        });
    } else if (msg.role === "assistant") {
      events.push({ type: "assistant-start", messageId: randomUUID() });
      for (const block of content) {
        if (block.type === "text" && block.text) {
          events.push({ type: "part-start", kind: "text" });
          events.push({ type: "part-delta", delta: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          events.push({ type: "part-start", kind: "thinking" });
          events.push({ type: "part-delta", delta: block.thinking });
        } else if (block.type === "toolCall" && block.id) {
          events.push({
            type: "tool-call",
            toolId: block.id,
            name: block.name ?? "tool",
            args: block.arguments,
          });
        }
      }
      events.push({ type: "assistant-end" });
    } else if (msg.role === "toolResult" && msg.toolCallId) {
      events.push({
        type: "tool-end",
        toolId: msg.toolCallId,
        output: contentText(content),
        isError: msg.isError === true,
      });
    }
  }
  return events;
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
