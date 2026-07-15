import { randomUUID } from "node:crypto";
import {
  getSessionMessages,
  query,
  type ModelInfo,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
  type UserDialogRequest,
  type UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "../config.js";
import type {
  ChatAction,
  ChatEvent,
  ChatQuestion,
} from "../../shared/protocol.js";
import type {
  ChatSession,
  ChatSessionHandlers,
  HarnessAdapter,
  SessionOptions,
} from "./types.js";

// Model switcher ordering (smallest → largest); only applied when every model
// is a known family (otherwise unknown models can't be ranked → SDK order).
const KNOWN_MODEL_ORDER = ["haiku", "sonnet", "opus", "fable", "mythos"];

// Runtime permission-mode toggle (curated subset of PermissionMode, omits
// bypassPermissions/dontAsk). `id` is passed to query.setPermissionMode.
const PERMISSION_MODES: {
  id: PermissionMode;
  label: string;
  description: string;
}[] = [
  { id: "default", label: "Default", description: "Prompt for anything not auto-allowed" },
  { id: "plan", label: "Plan", description: "Plan only — no tools are executed" },
  { id: "acceptEdits", label: "Allow all edits", description: "Auto-accept file edits" },
  { id: "auto", label: "Auto", description: "A model classifier approves or denies prompts" },
];
const DEFAULT_MODE: PermissionMode = "default";

// The bare "opus" alias resolves to the latest Opus (tracks newest without a
// version bump here). Seeds query({ model }) and the UI's initial selection.
const DEFAULT_MODEL = "opus";

// Permission-card button labels, shared by the emitted card and the ui-response
// handler that maps a label back to a decision, so the two never drift.
const ALLOW = "Allow";
const DENY = "Deny";
const ALWAYS_ALLOW = "Always allow";
// For edit tools "always" flips the session into acceptEdits mode rather than
// installing a scoped rule (mirrors the TUI), so it gets a mode-oriented label.
const ALLOW_ALL_EDITS = "Allow all edits";

// Tools whose "always" means switch to acceptEdits mode, not a per-call rule.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// CLI dialog kind for AskUserQuestion. Declaring it in supportedDialogKinds
// (+ onUserDialog) routes the tool through the structured question dialog
// instead of a raw permission card; we answer with a PermissionResult whose
// updatedInput carries the chosen answers (as the TUI does).
const ASK_QUESTION_DIALOG = "permission_ask_user_question";

interface AskQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label?: string; description?: string }[];
}

// Parse AskUserQuestion input (`{ questions: [...] }`) into ChatQuestion[],
// dropping malformed entries. Shared by the canUseTool and onUserDialog paths.
function parseQuestions(input: unknown): ChatQuestion[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  return (raw as AskQuestion[])
    .filter((q) => typeof q.question === "string" && Array.isArray(q.options))
    .map((q) => ({
      question: q.question as string,
      header: q.header,
      multiSelect: q.multiSelect === true,
      options: (q.options ?? [])
        .filter((o) => typeof o.label === "string")
        .map((o) => ({ label: o.label as string, description: o.description })),
    }));
}

function modelRank(m: ModelInfo): number {
  const id = m.value.toLowerCase();
  return KNOWN_MODEL_ORDER.findIndex((family) => id.includes(family));
}

// Sort smallest → largest only when every model is a known family; else SDK order.
function sortModels(models: readonly ModelInfo[]): ModelInfo[] {
  if (models.some((m) => modelRank(m) === -1)) return [...models];
  return [...models].sort((a, b) => modelRank(a) - modelRank(b));
}

// Claude Code adapter. Drives the Claude Agent SDK (which owns its own
// subprocess and exposes canUseTool / setModel / supportedCommands), so it's a
// ChatSession, not a ChatTranslator like pi. All Claude/SDK specifics stay here.
// Billing: no ANTHROPIC_API_KEY → the CLI auths from the user's subscription.
export function createClaudeAdapter(cfg: HarnessConfig): HarnessAdapter {
  return {
    id: "claude",
    name: "Claude Code",
    // Unused for the chat path (SDK spawns its own executable) but interface-required.
    invocation(_opts: SessionOptions): { command: string; args: string[] } {
      return { command: cfg.command, args: [] };
    },
    createChatSession(opts: SessionOptions): ChatSession {
      return new ClaudeChatSession(opts);
    },
  };
}

class ClaudeChatSession implements ChatSession {
  private handlers?: ChatSessionHandlers;
  private q?: Query;
  private readonly abort = new AbortController();
  private pushInput?: (msg: SDKUserMessage) => void;
  private closeInput?: () => void;
  private closed = false;
  private errored = false;
  /** Turn in progress (drives the busy indicator). */
  private busy = false;
  /** Set on stream `message_start`, cleared on `result`. Lets us ignore the
   * SDK's whole-message echo of a turn we already built from deltas. */
  private streamedThisTurn = false;
  /** Streaming tool-use blocks keyed by block index; args arrive as
   * input_json_delta fragments. */
  private toolBlocks = new Map<number, ToolBlock>();
  /** Pending permission decisions keyed by ChatUiRequest id. */
  private permResolvers = new Map<
    string,
    (decision: PermDecision, note?: string) => void
  >();
  /** Pending AskUserQuestion dialogs keyed by ChatUiRequest id; resolved with
   * the answers map, or null when cancelled. */
  private dialogResolvers = new Map<
    string,
    (answers: Record<string, string> | null) => void
  >();

  constructor(private opts: SessionOptions) {}

  start(handlers: ChatSessionHandlers): void {
    this.handlers = handlers;
    const input = createPushStream<SDKUserMessage>();
    this.pushInput = input.push;
    this.closeInput = input.close;

    const q = query({
      prompt: input.stream,
      options: {
        cwd: this.opts.cwd,
        // default = auto-allow read-only, consult canUseTool for the rest.
        // Switchable at runtime via set-mode → setPermissionMode.
        permissionMode: DEFAULT_MODE,
        model: DEFAULT_MODEL,
        // resume restores the model's context but does NOT stream history back —
        // we rebuild the visible transcript ourselves in replayHistory.
        ...(this.opts.resume ? { resume: this.opts.resume } : {}),
        includePartialMessages: true,
        abortController: this.abort,
        // Declaring canUseTool is what makes Claude send structured permission
        // requests instead of silently sandboxing/denying.
        canUseTool: (toolName, toolInput, { suggestions }) =>
          new Promise<PermissionResult>((resolve) => {
            // AskUserQuestion is a question, not a permission: render a structured
            // `questions` card and answer via updatedInput.answers (as the TUI
            // does). Routed here because the CLI doesn't reliably fire
            // onUserDialog for it in the SDK path; canUseTool always fires.
            if (toolName === "AskUserQuestion") {
              const questions = parseQuestions(toolInput);
              if (!questions.length) {
                resolve({ behavior: "allow", updatedInput: toolInput });
                return;
              }
              const qid = randomUUID();
              this.dialogResolvers.set(qid, (answers) => {
                if (!answers) {
                  resolve({ behavior: "deny", message: "Cancelled by user" });
                  return;
                }
                resolve({
                  behavior: "allow",
                  updatedInput: { ...(toolInput as object), answers },
                });
              });
              this.emit({
                type: "ui-request",
                request: {
                  id: qid,
                  kind: "questions",
                  title:
                    questions.length > 1
                      ? "Claude has a few questions"
                      : "Claude has a question",
                  questions,
                },
              });
              return;
            }
            const id = randomUUID();
            const isEdit = EDIT_TOOLS.has(toolName);
            // Offer "always" for edit tools (flips to acceptEdits) or when the
            // SDK computed scoped rules (e.g. `Bash(npm test:*)`); hidden
            // otherwise, matching the TUI.
            const canAlways =
              isEdit || (Array.isArray(suggestions) && suggestions.length > 0);
            this.permResolvers.set(id, (decision, note) => {
              if (decision === "deny") {
                // A note becomes the deny message the CLI feeds back to the model.
                resolve({
                  behavior: "deny",
                  message: note?.trim() || "Denied by user",
                });
              } else if (decision === "always" && isEdit) {
                // Allow this call, then switch to acceptEdits so later edits
                // stop prompting (mode toggle updates via applyMode's event).
                resolve({ behavior: "allow", updatedInput: toolInput });
                this.applyMode("acceptEdits");
              } else if (decision === "always") {
                // Returning suggestions verbatim keeps their session-scoped
                // destination: auto-allow this session, forgotten on restart.
                resolve({
                  behavior: "allow",
                  updatedInput: toolInput,
                  updatedPermissions: suggestions,
                });
              } else {
                resolve({ behavior: "allow", updatedInput: toolInput });
              }
            });
            this.emit({
              type: "ui-request",
              request: {
                id,
                kind: "select",
                title: `Allow ${toolName}?`,
                message: summarizeInput(toolInput),
                options: canAlways
                  ? [ALLOW, isEdit ? ALLOW_ALL_EDITS : ALWAYS_ALLOW, DENY]
                  : [ALLOW, DENY],
              },
            });
          }),
        // Fallback if a future CLI routes AskUserQuestion via onUserDialog (it
        // doesn't today — handled in canUseTool above). Only listed kinds emit.
        supportedDialogKinds: [ASK_QUESTION_DIALOG],
        onUserDialog: (request) => this.handleUserDialog(request),
      },
    });
    this.q = q;
    // Fixed synchronous list — emit now so the toggle is present from first render.
    this.emit({
      type: "modes",
      modes: PERMISSION_MODES,
      current: DEFAULT_MODE,
    });
    // The live stream doesn't replay history on resume, so rebuild it from disk.
    if (this.opts.resume) void this.replayHistory(this.opts.resume);
    void this.consume(q);
    // Eager fetch: models/commands resolve on connect (no prompt needed), so the
    // switcher and palette are ready before the first message.
    void this.loadControlInfo(q);
  }

  /** Switch permission mode and reflect it in the UI. Shared by the set-mode
   * action and the "Allow all edits" decision. */
  private applyMode(mode: PermissionMode): void {
    this.q
      ?.setPermissionMode(mode)
      .then(() => this.emit({ type: "mode-changed", current: mode }))
      .catch((e: Error) =>
        this.emit({
          type: "notice",
          level: "error",
          text: `Mode switch failed: ${e.message}`,
        }),
      );
  }

  private async loadControlInfo(q: Query): Promise<void> {
    try {
      const [models, commands] = await Promise.all([
        q.supportedModels(),
        q.supportedCommands(),
      ]);
      // Reflect the seeded DEFAULT_MODEL as current; fall back to the first row.
      const defaultModel =
        models.find((m: ModelInfo) => m.value.toLowerCase().includes(DEFAULT_MODEL)) ??
        models[0];
      this.emit({
        type: "models",
        models: sortModels(models).map((m: ModelInfo) => ({
          id: m.value,
          label: m.displayName,
          description: m.description,
        })),
        current: defaultModel?.value ?? null,
      });
      this.emit({
        type: "commands",
        commands: commands.map((c: SlashCommand) => ({
          name: c.name,
          description: c.description,
        })),
      });
    } catch {
      // Non-fatal: the session still works without a model/command list.
    }
  }

  /** Render AskUserQuestion as a structured dialog and return the picks as the
   * CLI's PermissionResult (answers in updatedInput.answers). Other kinds
   * cancel, so the CLI applies its default. */
  private handleUserDialog(
    request: UserDialogRequest,
  ): Promise<UserDialogResult> {
    return new Promise<UserDialogResult>((resolve) => {
      const payload = request.payload as Record<string, unknown>;
      const questions =
        request.dialogKind === ASK_QUESTION_DIALOG
          ? parseQuestions(payload)
          : [];
      if (!questions.length) {
        resolve({ behavior: "cancelled" });
        return;
      }
      const id = randomUUID();
      this.dialogResolvers.set(id, (answers) => {
        if (!answers) {
          resolve({ behavior: "cancelled" });
          return;
        }
        resolve({
          behavior: "completed",
          result: {
            behavior: "allow",
            updatedInput: { questions: payload.questions, answers },
          },
        });
      });
      this.emit({
        type: "ui-request",
        request: {
          id,
          kind: "questions",
          title:
            questions.length > 1
              ? "Claude has a few questions"
              : "Claude has a question",
          questions,
        },
      });
    });
  }

  action(action: ChatAction): void {
    switch (action.type) {
      case "prompt":
        this.pushInput?.({
          type: "user",
          message: { role: "user", content: action.text },
          parent_tool_use_id: null,
        });
        this.emit({
          type: "user-message",
          message: {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: action.text }],
            createdAt: Date.now(),
          },
        });
        break;
      case "abort":
        this.q?.interrupt().catch(() => {});
        break;
      case "ui-response": {
        // AskUserQuestion dialogs resolve with answers.
        const dialog = this.dialogResolvers.get(action.requestId);
        if (dialog) {
          this.dialogResolvers.delete(action.requestId);
          this.emit({ type: "ui-request-done", requestId: action.requestId });
          dialog(action.cancelled ? null : (action.answers ?? {}));
          return;
        }
        const resolve = this.permResolvers.get(action.requestId);
        if (!resolve) return;
        this.permResolvers.delete(action.requestId);
        this.emit({ type: "ui-request-done", requestId: action.requestId });
        const denied =
          action.cancelled === true ||
          action.confirmed === false ||
          action.value === DENY;
        const decision: PermDecision = denied
          ? "deny"
          : action.value === ALWAYS_ALLOW || action.value === ALLOW_ALL_EDITS
            ? "always"
            : "allow";
        resolve(decision, action.note);
        break;
      }
      case "set-model":
        this.q
          ?.setModel(action.model === "default" ? undefined : action.model)
          .then(() =>
            this.emit({ type: "model-changed", current: action.model }),
          )
          .catch((e: Error) =>
            this.emit({
              type: "notice",
              level: "error",
              text: `Model switch failed: ${e.message}`,
            }),
          );
        break;
      case "set-mode":
        this.applyMode(action.mode as PermissionMode);
        break;
    }
  }

  close(): void {
    this.closed = true;
    this.closeInput?.();
    this.abort.abort();
    // Release dangling prompts so the SDK loop can unwind.
    for (const resolve of this.permResolvers.values()) resolve("deny");
    this.permResolvers.clear();
    for (const resolve of this.dialogResolvers.values()) resolve(null);
    this.dialogResolvers.clear();
  }

  private emit(event: ChatEvent): void {
    this.handlers?.onEvent(event);
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handleMessage(msg);
    } catch (err) {
      if (!this.closed) {
        this.errored = true;
        this.emit({
          type: "notice",
          level: "error",
          text: (err as Error).message,
        });
      }
    } finally {
      this.handlers?.onExit(this.errored ? 1 : 0);
    }
  }

  private handleMessage(msg: SDKMessage): void {
    switch (msg.type) {
      case "stream_event":
        this.handleStreamEvent(msg.event as StreamEvent);
        break;
      case "system":
        // init carries the session id (our resume key) + resumed permission mode.
        if (msg.subtype === "init") {
          this.handlers?.onResumable?.(msg.session_id);
          if (msg.permissionMode)
            this.emit({ type: "mode-changed", current: msg.permissionMode });
        }
        break;
      case "user": {
        const content = (msg.message as { content?: unknown } | undefined)
          ?.content;
        this.handleToolResults(content);
        // Live user echoes skipped (emitted on the `prompt` action). isReplay is
        // a vestigial safety net — the SDK doesn't emit it on resume.
        if ("isReplay" in msg && msg.isReplay) this.replayUserMessage(content);
        break;
      }
      case "assistant":
        // Live turns are built from deltas; ignore the SDK's whole-message echo.
        // A whole message with no preceding deltas is rebuilt as a safety net.
        if (!this.streamedThisTurn)
          this.replayAssistantMessage(
            (msg.message as { content?: unknown } | undefined)?.content,
            msg.uuid,
          );
        break;
      case "result":
        // Turn finished (success, error, or interrupt) — clear busy.
        this.busy = false;
        this.streamedThisTurn = false;
        this.toolBlocks.clear();
        this.emit({ type: "busy", busy: false });
        break;
    }
  }

  /** Rebuild a resumed conversation's transcript from its on-disk JSONL (the
   * live stream doesn't replay it), folding whole messages through the same
   * helpers the live path uses so history bubbles match freshly-streamed ones. */
  private async replayHistory(sessionId: string): Promise<void> {
    let messages;
    try {
      messages = await getSessionMessages(sessionId, { dir: this.opts.cwd });
    } catch (err) {
      this.emit({
        type: "notice",
        level: "error",
        text: `Couldn't load conversation history: ${(err as Error).message}`,
      });
      return;
    }
    for (const m of messages) {
      if (this.closed) return;
      const content = (m.message as { content?: unknown } | undefined)?.content;
      if (m.type === "assistant") {
        this.replayAssistantMessage(content, m.uuid);
      } else if (m.type === "user") {
        // May carry tool_result blocks and/or genuine prose — emit both.
        this.handleToolResults(content);
        this.replayUserMessage(content);
      }
    }
  }

  /** Rebuild a replayed user prompt into a bubble (only genuine user text). */
  private replayUserMessage(content: unknown): void {
    const text = userText(content);
    if (!text) return;
    this.emit({
      type: "user-message",
      message: {
        id: randomUUID(),
        role: "user",
        parts: [{ type: "text", text }],
        createdAt: Date.now(),
      },
    });
  }

  /** Rebuild a whole assistant message into a bubble via the live delta events. */
  private replayAssistantMessage(content: unknown, uuid: string): void {
    if (!Array.isArray(content)) return;
    this.emit({ type: "assistant-start", messageId: uuid });
    for (const block of content as ContentBlock[]) {
      if (block?.type === "text" && typeof block.text === "string") {
        this.emit({ type: "part-start", kind: "text" });
        this.emit({ type: "part-delta", delta: block.text });
      } else if (
        block?.type === "thinking" &&
        typeof block.thinking === "string"
      ) {
        this.emit({ type: "part-start", kind: "thinking" });
        this.emit({ type: "part-delta", delta: block.thinking });
      } else if (block?.type === "tool_use" && block.id) {
        this.emit({
          type: "tool-call",
          toolId: block.id,
          name: block.name ?? "tool",
          args: block.input,
        });
      }
    }
    this.emit({ type: "assistant-end" });
  }

  private handleStreamEvent(event: StreamEvent | undefined): void {
    switch (event?.type) {
      case "message_start": {
        this.toolBlocks.clear();
        // Mark the turn streamed so its whole-message echo is ignored.
        this.streamedThisTurn = true;
        if (!this.busy) {
          this.busy = true;
          this.emit({ type: "busy", busy: true });
        }
        this.emit({ type: "assistant-start", messageId: randomUUID() });
        break;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block?.type === "text") this.emit({ type: "part-start", kind: "text" });
        else if (block?.type === "thinking")
          this.emit({ type: "part-start", kind: "thinking" });
        else if (block?.type === "tool_use" && typeof event.index === "number")
          this.toolBlocks.set(event.index, {
            id: block.id ?? randomUUID(),
            name: block.name ?? "tool",
            initialInput: block.input,
            json: "",
          });
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta?.type === "text_delta" && delta.text)
          this.emit({ type: "part-delta", delta: delta.text });
        else if (delta?.type === "thinking_delta" && delta.thinking)
          this.emit({ type: "part-delta", delta: delta.thinking });
        else if (
          delta?.type === "input_json_delta" &&
          typeof event.index === "number"
        ) {
          const tool = this.toolBlocks.get(event.index);
          if (tool) tool.json += delta.partial_json ?? "";
        }
        break;
      }
      case "content_block_stop": {
        if (typeof event.index !== "number") break;
        const tool = this.toolBlocks.get(event.index);
        if (!tool) break;
        this.toolBlocks.delete(event.index);
        this.emit({
          type: "tool-call",
          toolId: tool.id,
          name: tool.name,
          args: parseToolArgs(tool),
        });
        break;
      }
      case "message_stop":
        this.emit({ type: "assistant-end" });
        break;
    }
  }

  private handleToolResults(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content as ToolResultBlock[]) {
      if (block?.type !== "tool_result" || !block.tool_use_id) continue;
      this.emit({
        type: "tool-end",
        toolId: block.tool_use_id,
        output: contentText(block.content),
        isError: block.is_error === true,
      });
    }
  }
}

/** Pushable async iterator: the SDK consumes `stream` as prompt input while we
 * `push` user messages and `close` to end the session. */
function createPushStream<T>(): {
  stream: AsyncGenerator<T>;
  push: (value: T) => void;
  close: () => void;
} {
  const buffer: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  async function* stream(): AsyncGenerator<T> {
    while (true) {
      while (buffer.length) yield buffer.shift()!;
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  }
  return {
    stream: stream(),
    push(value) {
      buffer.push(value);
      wake?.();
    },
    close() {
      done = true;
      wake?.();
    },
  };
}

/** How the user answered a permission card. */
type PermDecision = "allow" | "always" | "deny";

interface ToolBlock {
  id: string;
  name: string;
  initialInput: unknown;
  json: string;
}

function parseToolArgs(tool: ToolBlock): unknown {
  if (tool.json) {
    try {
      return JSON.parse(tool.json);
    } catch {
      // Fall back to whatever was present at block start.
    }
  }
  return tool.initialInput;
}

/** A one-line summary of a tool's input for a permission card. */
function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const values = Object.values(input as Record<string, unknown>);
    if (values.length === 1 && typeof values[0] === "string") return values[0];
  }
  try {
    const s = input === undefined ? "" : JSON.stringify(input);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return "";
  }
}

/** A content block of a replayed assistant message (loose shape — we read only
 * the fields we render). */
interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** Extract the user-authored text from a message's content (string, or an array
 * of text blocks). Tool-result blocks are ignored — they aren't user prose. */
function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) =>
      block?.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("")
    .trim();
}

/** Flatten tool-result content — a string or an array of text blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) =>
      block?.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("");
}

// --- Loose shapes of the Anthropic stream events we read off SDK messages ----

interface StreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
}

interface ToolResultBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
