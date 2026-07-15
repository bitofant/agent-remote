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

// Known Anthropic model families, smallest → largest capability. Used to give
// the model switcher a sensible default order (the SDK returns them in an
// arbitrary order). We only apply this ordering when EVERY model in the list is
// one of these five known families — otherwise we can't rank an unknown model,
// so we leave the SDK order untouched.
const KNOWN_MODEL_ORDER = ["haiku", "sonnet", "opus", "fable", "mythos"];

// Permission modes the UI offers as a runtime toggle (a curated subset of the
// SDK's PermissionMode union — we omit bypassPermissions/dontAsk). `id` is the
// exact value passed to `query.setPermissionMode`.
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

// Model new sessions start on. The SDK/CLI resolves the bare "opus" alias to the
// latest Opus release, so this tracks the newest Opus without a version bump
// here. Used both to seed `query({ model })` and to pick the UI's initial
// `current` model from the fetched `supportedModels` list.
const DEFAULT_MODEL = "opus";

// Permission-card button labels. Shared between the card the adapter emits and
// the `ui-response` handler that maps the chosen label back to a decision, so
// the two never drift.
const ALLOW = "Allow";
const DENY = "Deny";
const ALWAYS_ALLOW = "Always allow";
// For edit tools the "always" button doesn't install a scoped rule — it flips
// the session into acceptEdits mode (mirrors the TUI's "allow all edits during
// this session"), so it gets a mode-oriented label.
const ALLOW_ALL_EDITS = "Allow all edits";

// Tools whose "always" decision means "stop prompting for edits" — i.e. switch
// to acceptEdits permission mode — rather than installing a per-call rule.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// The CLI's dialog kind for the AskUserQuestion tool. Declaring it in
// `supportedDialogKinds` (plus an `onUserDialog` handler) routes that tool
// through the structured question dialog instead of falling back to a raw
// permission card that dumps the questions JSON. Payload shape (CLI 2.1.x):
// { requestId, toolName, permissionResult, questions }; we answer with a
// PermissionResult whose updatedInput carries the chosen answers — exactly
// what the TUI's own handler returns.
const ASK_QUESTION_DIALOG = "permission_ask_user_question";

interface AskQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label?: string; description?: string }[];
}

// Parse the AskUserQuestion tool input (`{ questions: [...] }`) into the
// protocol's ChatQuestion shape, dropping malformed entries. Shared by the
// canUseTool special-case and the onUserDialog fallback so both render the same
// card. Accepts either the tool input or a dialog payload.
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

// Sort smallest → largest when the list consists exclusively of the known five
// Anthropic model families; otherwise return the list unchanged (SDK order).
function sortModels(models: readonly ModelInfo[]): ModelInfo[] {
  if (models.some((m) => modelRank(m) === -1)) return [...models];
  return [...models].sort((a, b) => modelRank(a) - modelRank(b));
}

// Adapter for Claude Code. Unlike pi (a stdio translator over a manager-owned
// pipe), the claude harness drives the Claude Agent SDK, which owns its own
// subprocess and — crucially — exposes first-class permission requests
// (`canUseTool`), model switching (`setModel`/`supportedModels`), and slash
// command inspection (`supportedCommands`). That's why this is a ChatSession,
// not a ChatTranslator. All Claude/SDK specifics stay in this file.
//
// Billing: the SDK drives the Claude Code CLI, which authenticates from the
// user's subscription (OAuth/keychain) exactly like the interactive harness —
// as long as no ANTHROPIC_API_KEY is set. We never force API-key auth here.
export function createClaudeAdapter(cfg: HarnessConfig): HarnessAdapter {
  return {
    id: "claude",
    name: "Claude Code",
    // Unused for the chat path (the SDK spawns its own executable), but the
    // interface requires it.
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
  /** Whether the current turn produced stream deltas. Live turns stream a bubble
   * via deltas, then the SDK re-sends it as a whole `assistant` message — this
   * flag lets us ignore that duplicate. (Resume history is not streamed by the
   * SDK; it's rebuilt separately from disk in replayHistory.) Set on a stream
   * `message_start`; reset when the turn's `result` lands. */
  private streamedThisTurn = false;
  /** Tool-use content blocks streaming in the current assistant message, keyed
   * by block index; their arguments arrive as input_json_delta fragments. */
  private toolBlocks = new Map<number, ToolBlock>();
  /** Pending permission decisions, keyed by the ChatUiRequest id we minted.
   * "always" allows and installs the SDK-suggested rules so matching calls
   * stop prompting; "allow" is one-shot; "deny" rejects. */
  private permResolvers = new Map<
    string,
    (decision: PermDecision, note?: string) => void
  >();
  /** Pending AskUserQuestion dialogs, keyed by the ChatUiRequest id we minted.
   * Resolved with the answers map, or null when cancelled. */
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
        // "default" = auto-allow read-only tools, consult canUseTool for
        // anything that would otherwise prompt. Exactly the interactive posture.
        // The user can switch this at runtime via `set-mode` → setPermissionMode.
        permissionMode: DEFAULT_MODE,
        // Start new sessions on the latest Opus (the CLI resolves this alias).
        // The user can still switch via the model picker (set-model).
        model: DEFAULT_MODEL,
        // Resume a prior conversation when a resume key was supplied: the SDK
        // restores the model's context (it does NOT stream the history back —
        // we rebuild the visible transcript ourselves in replayHistory).
        ...(this.opts.resume ? { resume: this.opts.resume } : {}),
        includePartialMessages: true,
        abortController: this.abort,
        // The handshake the raw stdio protocol lacked: declaring canUseTool is
        // what makes Claude send structured permission requests instead of
        // sandboxing/denying silently.
        canUseTool: (toolName, toolInput, { suggestions }) =>
          new Promise<PermissionResult>((resolve) => {
            // AskUserQuestion is a question, not a permission: render it as a
            // structured `questions` card (never an Allow/Deny card) and answer
            // with `updatedInput.answers`, mirroring the TUI. We do this through
            // canUseTool because the CLI does NOT reliably route this tool via
            // onUserDialog in the SDK path — canUseTool always fires, so it's
            // the dependable hook.
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
            // Offer an "always" button when either: it's an edit tool (the
            // button flips to acceptEdits mode), or the SDK/bridge computed
            // scoped rules that would keep this kind of call from prompting
            // again (e.g. `Bash(npm test:*)`) — matching the TUI, which hides
            // its "don't ask again" option for requests with no rule.
            const canAlways =
              isEdit || (Array.isArray(suggestions) && suggestions.length > 0);
            this.permResolvers.set(id, (decision, note) => {
              if (decision === "deny") {
                // A free-text note becomes the deny message, which the CLI feeds
                // back to the model as the tool result — the TUI's "No, <why>".
                resolve({
                  behavior: "deny",
                  message: note?.trim() || "Denied by user",
                });
              } else if (decision === "always" && isEdit) {
                // "Allow all edits" — allow this call, then switch the session
                // into acceptEdits so subsequent edits stop prompting. The mode
                // toggle updates via the mode-changed event applyMode emits.
                resolve({ behavior: "allow", updatedInput: toolInput });
                this.applyMode("acceptEdits");
              } else if (decision === "always") {
                // Returning the suggestions verbatim keeps their `destination`
                // (typically "session"): auto-allow for the rest of this
                // session, forgotten on restart — the TUI's quick default.
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
        // Belt-and-suspenders: if a future CLI does route AskUserQuestion via
        // onUserDialog (it doesn't in the SDK path today — see the canUseTool
        // special-case above), handle it here too. Only kinds listed here are
        // emitted; everything else keeps the canUseTool path.
        supportedDialogKinds: [ASK_QUESTION_DIALOG],
        onUserDialog: (request) => this.handleUserDialog(request),
      },
    });
    this.q = q;
    // Permission modes are a fixed, synchronous list (no SDK round-trip), so
    // emit them right away — the toggle is present from the first render.
    this.emit({
      type: "modes",
      modes: PERMISSION_MODES,
      current: DEFAULT_MODE,
    });
    // On resume, the live SDK stream does NOT replay the prior conversation
    // (verified against the CLI: nothing is emitted until the first new prompt,
    // and even then only the new turn arrives — no isReplay messages). So we
    // rebuild the transcript ourselves from disk via getSessionMessages, using
    // the same replay helpers the (now vestigial) isReplay path used.
    if (this.opts.resume) void this.replayHistory(this.opts.resume);
    void this.consume(q);
    // Fetch models + slash commands eagerly: they resolve on connect (no prompt
    // needed), so the model switcher and command palette are available before
    // the first message. system/init isn't emitted until a turn starts.
    void this.loadControlInfo(q);
  }

  /** Switch the session's permission mode and reflect it in the UI. Shared by
   * the `set-mode` action and the "Allow all edits" permission decision. */
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
      // We seed the session with the latest Opus (query({ model: DEFAULT_MODEL }))
      // so reflect that as the current selection — fall back to the first row if
      // the list has no Opus entry. Explicit switches come via model-changed.
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

  /** Render the AskUserQuestion tool as a structured question dialog and turn
   * the user's picks into the PermissionResult the CLI expects (the chosen
   * labels ride back in `updatedInput.answers`, mirroring the TUI). Any other
   * dialog kind is cancelled, so the CLI applies its own default. */
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
        // A structured question dialog (AskUserQuestion) resolves with answers.
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
    // Release any dangling permission prompts so the SDK loop can unwind.
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
        // The init handshake carries the harness-native session id (our resume
        // key) and the resumed permission mode. Emitted for fresh and resumed
        // sessions alike.
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
        // Live user echoes are skipped (the adapter emits its own user-message
        // on the `prompt` action). `isReplay` messages would be historical
        // prompts, but the SDK doesn't actually emit them on resume — history is
        // rebuilt from disk in replayHistory instead. Kept as a safety net.
        if ("isReplay" in msg && msg.isReplay) this.replayUserMessage(content);
        break;
      }
      case "assistant":
        // Live assistant turns are built from deltas; the SDK's whole-message
        // echo (streamedThisTurn) is redundant. A whole message with no
        // preceding deltas is rebuilt as a safety net (resume history proper is
        // handled up front in replayHistory).
        if (!this.streamedThisTurn)
          this.replayAssistantMessage(
            (msg.message as { content?: unknown } | undefined)?.content,
            msg.uuid,
          );
        break;
      case "result":
        // Turn finished (success, error, or interrupt); all clear busy.
        this.busy = false;
        this.streamedThisTurn = false;
        this.toolBlocks.clear();
        this.emit({ type: "busy", busy: false });
        break;
    }
  }

  /** Rebuild the visible transcript of a resumed conversation from its on-disk
   * JSONL (the live SDK stream doesn't replay it). Reads whole messages in
   * chronological order and folds them through the same helpers the live path
   * uses, so history bubbles are identical to freshly-streamed ones. */
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
        // A user message may carry tool_result blocks (close out prior tool
        // calls) and/or genuine user prose (a new bubble) — emit both.
        this.handleToolResults(content);
        this.replayUserMessage(content);
      }
    }
  }

  /** Rebuild a replayed user prompt into a chat bubble. Tool-result carriers are
   * handled separately (handleToolResults); only genuine user text is emitted. */
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

  /** Rebuild a whole assistant message (from resume replay) into a streamed
   * bubble, reusing the same events the live delta path emits. */
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
        // A live turn is streaming — mark it so the SDK's whole-message echo of
        // this same turn (handled in handleMessage) is ignored, not duplicated.
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

/** A pushable async iterator: the SDK consumes `stream` as its prompt input
 * while we `push` user messages and `close` to end the session. */
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
