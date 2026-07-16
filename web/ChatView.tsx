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

function ToolPart({ part }: { part: Extract<ChatPart, { type: "tool" }> }) {
  const glyph = toolGlyph(part.status);
  const view = toolView(part);
  return (
    <details className="chat-tool" data-status={part.status}>
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

function UiRequestCard({
  request,
  onRespond,
}: {
  request: ChatUiRequest;
  onRespond: (response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
    answers?: Record<string, string>;
    note?: string;
  }) => void;
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
    <div className="chat-request">
      <div className="chat-request-title">{request.title}</div>
      {request.message && (
        <div className="chat-request-message">{request.message}</div>
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
            <button onClick={() => onRespond({ confirmed: true })}>Yes</button>
            {/* Rejection requires a reason (sent as the deny message). */}
            <button
              disabled={!note.trim()}
              onClick={() => onRespond({ confirmed: false, note })}
            >
              No
            </button>
          </>
        )}
        {request.kind === "select" &&
          (request.options ?? []).map((opt) => (
            <button
              key={opt}
              // "Deny" requires a typed reason (sent as the deny message).
              disabled={opt === "Deny" && !note.trim()}
              onClick={() =>
                onRespond(opt === "Deny" ? { value: opt, note } : { value: opt })
              }
            >
              {opt}
            </button>
          ))}
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

export function ChatView({
  client,
  sessionId,
  active,
  exited,
}: {
  client: Client;
  sessionId: string;
  active: boolean;
  exited: boolean;
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
          <UiRequestCard key={req.id} request={req} onRespond={respond(req.id)} />
        ))}
        {recentNotices.map((n, i) => (
          <div key={`${n.at}-${i}`} className={`chat-notice ${n.level}`}>
            {n.text}
          </div>
        ))}
      </div>
      {!exited && showCommands && state.commands.length > 0 && (
        <div className="chat-commands">
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
          {state.commands.length > 0 && (
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
