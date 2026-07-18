import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ChatMessage,
  ChatPart,
  ChatState,
  ChatUiRequest,
} from "../shared/protocol";
import { renderMarkdown, toolGlyph, toolView } from "../shared/render";
import type { ToolBody } from "../shared/render";
import type { Client } from "./client";

// Chat-bubble view for chat sessions (ui: "chat"). Harness-agnostic: renders the
// client's normalized ChatState, sends ChatActions back. Lazy-loaded so marked
// stays out of the initial bundle. Rendering primitives live in shared/render.ts
// so the server-side render-log captures exactly what's shown here.

function Markdown({ text }: { text: string }) {
  return (
    <div
      className="chat-md"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}

function ToolBodyView({ body }: { body: ToolBody }) {
  switch (body.kind) {
    case "none":
      return null;
    case "json":
      return <pre className="chat-tool-args">{body.text}</pre>;
    case "code":
      return (
        <div className="chat-tool-body">
          {body.label && <div className="chat-tool-path">{body.label}</div>}
          <pre className="chat-tool-code">{body.text}</pre>
        </div>
      );
    case "diff":
      return (
        <div className="chat-tool-body">
          {body.path && <div className="chat-tool-path">{body.path}</div>}
          <pre className="chat-tool-diff">
            {body.lines.map((l, i) => (
              <span
                key={i}
                className={
                  l.sign === "+" ? "diff-add" : l.sign === "-" ? "diff-del" : "diff-ctx"
                }
              >
                {`${l.sign} ${l.text}`}
              </span>
            ))}
          </pre>
        </div>
      );
  }
}

function ToolPart({
  part,
  open,
}: {
  part: Extract<ChatPart, { type: "tool" }>;
  open?: boolean;
}) {
  const glyph = toolGlyph(part.status);
  const view = toolView(part);
  return (
    <details className="chat-tool" data-status={part.status} open={open}>
      <summary>
        <span className="chat-tool-glyph">{glyph}</span>
        <span className="chat-tool-name">{part.name}</span>
        {view.primary && <span className="chat-tool-preview">{view.primary}</span>}
        {view.secondary && <span className="chat-tool-desc">{view.secondary}</span>}
      </summary>
      <ToolBodyView body={view.body} />
      {part.output && <pre className="chat-tool-output">{part.output}</pre>}
    </details>
  );
}

function Bubble({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  if (message.role === "user") {
    const text = message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    return <div className="chat-bubble user">{text}</div>;
  }
  return (
    <div className={`chat-bubble assistant${streaming ? " streaming" : ""}`}>
      {message.parts.map((part, i) => {
        switch (part.type) {
          case "text":
            return <Markdown key={i} text={part.text} />;
          case "thinking":
            // No reasoning text (claude never streams it) → a plain live
            // "Thinking…" label; the reducer strips this part once the next
            // part starts. With text (pi) → the collapsible transcript.
            return part.text.trim() === "" ? (
              <div key={i} className="chat-thinking-label">
                Thinking…
              </div>
            ) : (
              <details key={i} className="chat-thinking">
                <summary>Thinking…</summary>
                <div>{part.text}</div>
              </details>
            );
          case "tool":
            return <ToolPart key={part.toolId} part={part} />;
        }
      })}
      {streaming && message.parts.length === 0 && (
        <span className="chat-cursor" />
      )}
    </div>
  );
}

// Synthetic option offered on every `questions` prompt: pick it to answer with
// the free-text field alone (which then becomes required).
const OTHER = "Other";

// The LLM's verdict on a pending card. Auto-acting verdicts (accept/confirm/
// answer) are NOT applied immediately: the card counts down `delayMs` with a
// ring animation on the target button and fires only if the user doesn't
// intervene. `deny` never auto-acts — it just highlights Deny + pre-fills a
// reason for the user to confirm.
type AutoDecision =
  | { type: "accept"; value: string; delayMs: number }
  | { type: "confirm"; delayMs: number }
  | { type: "answer"; answers: Record<string, string>; delayMs: number }
  | { type: "deny"; note: string };

// ≈ character count of a canonical 2-question AskUserQuestion call — the
// reference size at which the auto-action countdown hits its 10s ceiling.
const AUTO_ACTION_REF_CHARS = 681;

// Grace period before an auto-action fires, scaled by how much the card asks
// the user to review: 2s (trivial) … 10s (a screenful). Gives time to react.
function autoActionDelayMs(contentChars: number): number {
  const ratio = Math.min(1, contentChars / AUTO_ACTION_REF_CHARS);
  return Math.round((2 + 8 * ratio) * 1000);
}

// How much there is to read in a card, for the delay above.
function requestContentChars(req: ChatUiRequest): number {
  if (req.kind === "questions") return JSON.stringify(req.questions ?? []).length;
  const toolChars = req.tool ? JSON.stringify(req.tool).length : 0;
  return toolChars || (req.message ?? req.title ?? "").length;
}

function UiRequestCard({
  request,
  onRespond,
  decision,
}: {
  request: ChatUiRequest;
  onRespond: (response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
    answers?: Record<string, string>;
    note?: string;
  }) => void;
  // Optional LLM verdict. Auto-acting verdicts count down (with a ring on the
  // target button) before firing; the user can cancel by interacting.
  decision?: AutoDecision;
}) {
  const [value, setValue] = useState("");
  // Rejection reason (Deny/No/Cancel), fed back to the model as the deny message.
  const [note, setNote] = useState("");
  // Free-text answers per question; appended to the chosen option, required (and
  // stands alone) when "Other" is picked.
  const [others, setOthers] = useState<Record<string, string>>({});
  const isPermission =
    request.kind === "select" || request.kind === "confirm";
  // Selected option labels per question (`questions` kind); multi-select holds many.
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const questions = request.questions ?? [];

  // --- Auto-action countdown ---------------------------------------------
  // Once cancelled it stays cancelled; the auto-action never fires for this
  // card. Any click on a control, or focusing an input/textarea, cancels.
  const [cancelled, setCancelled] = useState(false);
  const firedRef = useRef(false);
  const denySuggested = decision?.type === "deny";
  const autoActive = !!decision && decision.type !== "deny" && !cancelled;

  // Latest onRespond, so the countdown effect needn't depend on it (it's a
  // fresh closure each render; depending on it would reset the timer).
  const onRespondRef = useRef(onRespond);
  onRespondRef.current = onRespond;

  const cancelAuto = () => setCancelled(true);
  // Cancel on interaction with any control inside the card (but not e.g.
  // selecting text in a diff), matching "clicks a button / focuses the field".
  const onCardInteract = (e: React.SyntheticEvent) => {
    if (!autoActive) return;
    const el = e.target as HTMLElement;
    if (el.closest("button, input, textarea, select")) cancelAuto();
  };

  // Adopt the LLM's terse deny reason when it arrives (async, after mount).
  useEffect(() => {
    if (decision?.type === "deny" && decision.note)
      setNote((n) => n || decision.note);
  }, [decision]);

  // Reflect an auto-answer's choices in the UI so the user sees what's about to
  // be submitted while the countdown runs.
  useEffect(() => {
    if (decision?.type !== "answer") return;
    const next: Record<string, string[]> = {};
    for (const q of questions) {
      const a = decision.answers[q.question];
      if (a != null)
        next[q.question] = q.multiSelect ? a.split(",").map((s) => s.trim()) : [a];
    }
    setPicks(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision]);

  // The countdown itself. Cleared if cancelled (autoActive flips false) or on
  // unmount (the card is resolved). Fires exactly once.
  useEffect(() => {
    if (!autoActive || firedRef.current || !decision) return;
    const t = setTimeout(() => {
      firedRef.current = true;
      const fire = onRespondRef.current;
      if (decision.type === "accept") fire({ value: decision.value });
      else if (decision.type === "confirm") fire({ confirmed: true });
      else if (decision.type === "answer") fire({ answers: decision.answers });
    }, decision.delayMs);
    return () => clearTimeout(t);
  }, [autoActive, decision]);

  // Ring timing for whichever button the countdown will "press".
  const autoDelayStyle = autoActive
    ? ({
        ["--auto-duration" as string]: `${
          (decision as { delayMs: number }).delayMs
        }ms`,
      } as React.CSSProperties)
    : undefined;
  // Answer = chosen label(s) + appended free text. The synthetic "Other" label
  // is dropped — its free text stands in for it.
  const answerFor = (question: string) => {
    const parts = (picks[question] ?? []).filter((l) => l !== OTHER);
    const text = (others[question] ?? "").trim();
    if (text) parts.push(text);
    return parts.join(", ");
  };
  // Answerable once it has an answer; "Other" makes the free text mandatory.
  const answerValid = (question: string) => {
    const picked = picks[question] ?? [];
    if (picked.includes(OTHER) && !(others[question] ?? "").trim()) return false;
    return answerFor(question).length > 0;
  };
  const allAnswered =
    questions.length > 0 && questions.every((q) => answerValid(q.question));
  const toggle = (question: string, label: string, multi: boolean) =>
    setPicks((p) => {
      const cur = p[question] ?? [];
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      return { ...p, [question]: next };
    });
  return (
    <div
      className="chat-request"
      // Any deliberate interaction with a control cancels a pending auto-action.
      onPointerDownCapture={onCardInteract}
      onFocusCapture={onCardInteract}
    >
      <div className="chat-request-title">{request.title}</div>
      {request.message && (
        <div className="chat-request-message">{request.message}</div>
      )}
      {/* Permission cards render the tool through the same rich toolView the
          transcript uses (diff/code/path), expanded, instead of raw arg JSON. */}
      {request.tool && (
        <ToolPart
          part={{
            type: "tool",
            toolId: request.id,
            name: request.tool.name,
            args: request.tool.args,
            output: "",
            status: "pending",
          }}
          open
        />
      )}
      {request.kind === "questions" &&
        questions.map((q) => (
          <div key={q.question} className="chat-question">
            {q.header && <div className="chat-question-header">{q.header}</div>}
            <div className="chat-question-text">{q.question}</div>
            <div className="chat-question-options">
              {q.options.map((opt) => {
                const selected = (picks[q.question] ?? []).includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    className={`chat-question-option${selected ? " selected" : ""}`}
                    onClick={() =>
                      toggle(q.question, opt.label, q.multiSelect === true)
                    }
                  >
                    <span className="chat-question-label">{opt.label}</span>
                    {opt.description && (
                      <span className="chat-question-desc">
                        {opt.description}
                      </span>
                    )}
                  </button>
                );
              })}
              {/* "Other": the text field below supplies its answer (then required). */}
              <button
                key="__other__"
                className={`chat-question-option${
                  (picks[q.question] ?? []).includes(OTHER) ? " selected" : ""
                }`}
                onClick={() => toggle(q.question, OTHER, q.multiSelect === true)}
              >
                <span className="chat-question-label">Other</span>
              </button>
            </div>
            <input
              className="chat-question-other"
              value={others[q.question] ?? ""}
              placeholder={
                (picks[q.question] ?? []).includes(OTHER)
                  ? "Type your answer (required)"
                  : "Add detail (optional) — appended to your choice"
              }
              onChange={(e) =>
                setOthers((o) => ({ ...o, [q.question]: e.target.value }))
              }
            />
          </div>
        ))}
      {/* Reasoning box for permission cards — sent as the deny message. */}
      {isPermission && (
        <textarea
          className="chat-request-note"
          value={note}
          placeholder="Reason (required to reject) — sent to the model as the deny message"
          rows={2}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <div className="chat-request-actions">
        {request.kind === "questions" && (
          <button
            className={
              autoActive && decision?.type === "answer" ? "auto-press" : ""
            }
            style={decision?.type === "answer" ? autoDelayStyle : undefined}
            disabled={!allAnswered}
            onClick={() =>
              onRespond({
                answers: Object.fromEntries(
                  questions.map((q) => [q.question, answerFor(q.question)]),
                ),
              })
            }
          >
            Submit
          </button>
        )}
        {request.kind === "confirm" && (
          <>
            <button
              className={
                autoActive && decision?.type === "confirm" ? "auto-press" : ""
              }
              style={decision?.type === "confirm" ? autoDelayStyle : undefined}
              onClick={() => onRespond({ confirmed: true })}
            >
              Yes
            </button>
            {/* Rejection requires a reason (sent as the deny message). */}
            <button
              className={denySuggested ? "deny-suggested" : ""}
              disabled={!note.trim()}
              onClick={() => onRespond({ confirmed: false, note })}
            >
              No
            </button>
          </>
        )}
        {request.kind === "select" &&
          (request.options ?? []).map((opt) => {
            const isAutoAccept =
              autoActive &&
              decision?.type === "accept" &&
              opt === decision.value;
            return (
              <button
                key={opt}
                className={
                  isAutoAccept
                    ? "auto-press"
                    : denySuggested && (opt === "Deny" || opt === "Cancel")
                      ? "deny-suggested"
                      : ""
                }
                style={isAutoAccept ? autoDelayStyle : undefined}
                // "Deny" requires a typed reason (sent as the deny message).
                disabled={opt === "Deny" && !note.trim()}
                onClick={() =>
                  onRespond(
                    opt === "Deny" ? { value: opt, note } : { value: opt },
                  )
                }
              >
                {opt}
              </button>
            );
          })}
        {request.kind === "input" && (
          <>
            <input
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onRespond({ value });
              }}
            />
            <button onClick={() => onRespond({ value })}>Send</button>
          </>
        )}
        <button
          className="chat-request-cancel"
          onClick={() => onRespond({ cancelled: true, note })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Per-session AI-assistant settings (mirrors App's shape; structural). Purely a
// prop — ChatView owns none of this state.
export interface AssistantSettings {
  enabled: boolean;
  canAcceptPermissions: boolean;
  canAnswerQuestions: boolean;
  instructions: string;
}

export function ChatView({
  client,
  sessionId,
  active,
  exited,
  canResume,
  onResume,
  assistant,
  llmAvailable,
}: {
  client: Client;
  sessionId: string;
  active: boolean;
  exited: boolean;
  // Whether the folder has closed sessions to resume, and the opener for the
  // resume picker. `/resume` is a client-only entry in the slash-command menu
  // (not a harness command), so it lives alongside the real commands here.
  canResume: boolean;
  onResume: () => void;
  // Optional LLM-assist settings for this session (null = off), plus whether the
  // endpoint is currently reachable. Best-effort: any failure is a silent no-op.
  assistant: AssistantSettings | null;
  llmAvailable: boolean;
}) {
  const [state, setState] = useState<ChatState>(() => {
    // Synchronous initial read; the effect below subscribes for updates.
    const { initial, unsubscribe } = client.subscribeChat(sessionId, () => {});
    unsubscribe();
    return initial;
  });
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Sticky autoscroll: follow new output only while the user is at the bottom.
  const nearBottomRef = useRef(true);

  useEffect(() => {
    // Deltas arrive faster than React should render; coalesce to one per frame.
    let latest: ChatState | null = null;
    let frame: number | null = null;
    const { initial, unsubscribe } = client.subscribeChat(sessionId, (s) => {
      latest = s;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        if (latest) setState(latest);
      });
    });
    setState(initial);
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [client, sessionId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [state, active]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    client.chatAction(sessionId, { type: "prompt", text });
    setDraft("");
    nearBottomRef.current = true;
    const ta = textareaRef.current;
    if (ta) ta.style.height = "auto";
  }, [client, sessionId, draft]);

  // Auto-grow the composer with its content (up to the CSS max-height).
  const onDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };

  const respond = (requestId: string) =>
    (response: {
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
      answers?: Record<string, string>;
      note?: string;
    }) =>
      client.chatAction(sessionId, {
        type: "ui-response",
        requestId,
        ...response,
      });

  // --- Optional LLM assist ------------------------------------------------
  // Evaluate each pending request at most once, producing a per-request
  // `AutoDecision`. The card then counts down (with a ring on the target
  // button) before an auto-accept/answer fires — cancellable by the user. Deny
  // never auto-acts: it just highlights Deny + pre-fills a reason.
  const evaluatedRef = useRef<Set<string>>(new Set());
  const [decisions, setDecisions] = useState<Record<string, AutoDecision>>({});

  const setDecision = (id: string, d: AutoDecision) =>
    setDecisions((prev) => ({ ...prev, [id]: d }));

  useEffect(() => {
    // Forget decisions for requests that are no longer pending, so a re-used id
    // can be evaluated again and the map can't grow unbounded.
    const liveIds = new Set(state.pendingRequests.map((r) => r.id));
    for (const id of evaluatedRef.current) {
      if (!liveIds.has(id)) evaluatedRef.current.delete(id);
    }
    setDecisions((prev) => {
      const next: Record<string, AutoDecision> = {};
      let changed = false;
      for (const [id, s] of Object.entries(prev)) {
        if (liveIds.has(id)) next[id] = s;
        else changed = true;
      }
      return changed ? next : prev;
    });

    if (!assistant?.enabled || !llmAvailable) return;

    for (const req of state.pendingRequests) {
      if (evaluatedRef.current.has(req.id)) continue;
      const isPermission = req.kind === "select" || req.kind === "confirm";
      const isQuestions = req.kind === "questions";
      const want =
        (isPermission && assistant.canAcceptPermissions) ||
        (isQuestions && assistant.canAnswerQuestions);
      if (!want) continue;
      evaluatedRef.current.add(req.id);

      const delayMs = autoActionDelayMs(requestContentChars(req));
      const body = {
        kind: req.kind,
        tool: req.tool,
        options: req.options,
        questions: req.questions,
        instructions: assistant.instructions,
        capabilities: {
          permissions: assistant.canAcceptPermissions,
          questions: assistant.canAnswerQuestions,
        },
      };
      void fetch("/api/llm-evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((r) => (r.ok ? r.json() : { available: false }))
        .then((d: {
          available?: boolean;
          action?: string;
          reason?: string;
          answers?: Record<string, string>;
        }) => {
          if (!d.available || !d.action) return;
          if (d.action === "allow") {
            if (req.kind === "confirm") {
              setDecision(req.id, { type: "confirm", delayMs });
            } else {
              // First option that isn't a rejection is the "accept" choice.
              const accept = (req.options ?? []).find(
                (o) => o !== "Deny" && o !== "Cancel",
              );
              if (accept)
                setDecision(req.id, { type: "accept", value: accept, delayMs });
            }
          } else if (d.action === "deny") {
            // Never auto-deny: surface the reason and let the user confirm.
            setDecision(req.id, { type: "deny", note: d.reason ?? "" });
          } else if (d.action === "answer" && d.answers) {
            setDecision(req.id, {
              type: "answer",
              answers: d.answers,
              delayMs,
            });
          }
        })
        .catch(() => {
          // Best-effort: a failed evaluation just leaves the card manual.
        });
    }
  }, [state.pendingRequests, assistant, llmAvailable]);

  const recentNotices = state.notices.slice(-3);
  const [showCommands, setShowCommands] = useState(false);

  const insertCommand = (name: string) => {
    setDraft((d) => (d ? `${d} /${name} ` : `/${name} `));
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  return (
    <div
      className="chat-view"
      style={{ display: active ? "flex" : "none" }}
    >
      {(state.models.length > 0 || state.modes.length > 0) && (
        <div className="chat-header">
          {state.models.length > 0 && (
            <label className="chat-model">
              <span>Model</span>
              <select
                value={state.currentModel ?? ""}
                onChange={(e) =>
                  client.chatAction(sessionId, {
                    type: "set-model",
                    model: e.target.value,
                  })
                }
              >
                {/* If the current model isn't in the list, show it anyway. */}
                {state.currentModel &&
                  !state.models.some((m) => m.id === state.currentModel) && (
                    <option value={state.currentModel}>
                      {state.currentModel}
                    </option>
                  )}
                {state.models.map((m) => (
                  <option key={m.id} value={m.id} title={m.description}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {state.modes.length > 0 && (
            <label className="chat-model">
              <span>Mode</span>
              <select
                value={state.currentMode ?? ""}
                onChange={(e) =>
                  client.chatAction(sessionId, {
                    type: "set-mode",
                    mode: e.target.value,
                  })
                }
              >
                {state.modes.map((m) => (
                  <option key={m.id} value={m.id} title={m.description}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {state.messages.length === 0 && !state.streaming && (
          <div className="chat-empty">
            {exited ? "Session ended." : "Send a prompt to get started."}
          </div>
        )}
        {state.messages.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}
        {state.streaming && (
          <Bubble key={state.streaming.id} message={state.streaming} streaming />
        )}
        {state.queued.map((text, i) => (
          <div key={`q-${i}`} className="chat-bubble user queued">
            {text}
          </div>
        ))}
        {state.pendingRequests.map((req) => (
          <UiRequestCard
            key={req.id}
            request={req}
            onRespond={respond(req.id)}
            decision={decisions[req.id]}
          />
        ))}
        {recentNotices.map((n, i) => (
          <div key={`${n.at}-${i}`} className={`chat-notice ${n.level}`}>
            {n.text}
          </div>
        ))}
      </div>
      {!exited && showCommands && (state.commands.length > 0 || canResume) && (
        <div className="chat-commands">
          {canResume && (
            <button
              key="__resume"
              className="chat-command"
              onClick={() => {
                onResume();
                setShowCommands(false);
              }}
              title="Resume a previous session"
            >
              <span className="chat-command-name">/resume</span>
              <span className="chat-command-desc">
                Resume a previous session
              </span>
            </button>
          )}
          {state.commands.map((c) => (
            <button
              key={c.name}
              className="chat-command"
              onClick={() => insertCommand(c.name)}
              title={c.description}
            >
              <span className="chat-command-name">/{c.name}</span>
              {c.description && (
                <span className="chat-command-desc">{c.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {!exited && (
        <div className="chat-composer">
          {(state.commands.length > 0 || canResume) && (
            <button
              className={`chat-slash${showCommands ? " active" : ""}`}
              title="Slash commands"
              onClick={() => setShowCommands((s) => !s)}
            >
              /
            </button>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            placeholder={state.busy ? "Steer the agent…" : "Prompt…"}
            onChange={onDraftChange}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {state.busy && (
            <button
              className="chat-stop"
              title="Abort the current run"
              onClick={() =>
                client.chatAction(sessionId, { type: "abort" })
              }
            >
              Stop
            </button>
          )}
          <button
            className="chat-send"
            disabled={!draft.trim()}
            onClick={send}
          >
            {state.busy ? "Steer" : "Send"}
          </button>
        </div>
      )}
    </div>
  );
}
