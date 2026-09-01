// Single source of truth for turning a ChatPart/ChatMessage into displayed HTML.
// ChatView imports these primitives so the UI can't drift; server/chatLog.ts
// calls renderMessage() to capture exactly what the UI produces.

import { Marked } from "marked";
import type { AgentRun, ChatMessage, ChatPart } from "./protocol.js";

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Markdown renderer for assistant text; raw HTML is escaped, not injected.
export const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
  },
});

/** Render assistant markdown to HTML (synchronous — no async extensions). */
export const renderMarkdown = (text: string): string =>
  md.parse(text, { async: false }) as string;

export const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}…` : s;

/** The one-line argument preview shown next to a tool's name. */
export function argsPreview(args: unknown): string {
  if (args && typeof args === "object") {
    // A single primary arg (e.g. bash's `command`) reads better than JSON.
    const values = Object.values(args as Record<string, unknown>);
    if (values.length === 1 && typeof values[0] === "string")
      return values[0] as string;
  }
  try {
    return args === undefined ? "" : JSON.stringify(args);
  } catch {
    return "";
  }
}

/** Last two path segments (`…/dir/file.ts`), for a compact but legible subject. */
export function shortenPath(p: string): string {
  const segs = p.split("/").filter(Boolean);
  return segs.length <= 2 ? p : `…/${segs.slice(-2).join("/")}`;
}

export interface DiffLine {
  sign: " " | "+" | "-";
  text: string;
}

/** Minimal LCS line diff of two strings, for rendering an Edit as red/green
 * lines instead of two JSON-escaped blobs. Falls back to a plain remove-all /
 * add-all block when the inputs are large enough that O(n·m) would hurt. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000)
    return [
      ...a.map((text): DiffLine => ({ sign: "-", text })),
      ...b.map((text): DiffLine => ({ sign: "+", text })),
    ];
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ sign: " ", text: a[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ sign: "-", text: a[i++] });
    else out.push({ sign: "+", text: b[j++] });
  }
  while (i < n) out.push({ sign: "-", text: a[i++] });
  while (j < m) out.push({ sign: "+", text: b[j++] });
  return out;
}

/** How a tool's expanded body should be displayed. */
export type ToolBody =
  | { kind: "diff"; path?: string; lines: DiffLine[] }
  | { kind: "code"; label?: string; text: string }
  | { kind: "json"; text: string }
  | { kind: "none" };

/** A tool call's display model — the collapsed summary subject plus how to show
 * its args body. Field-driven (file_path/path, command, old/new_string, content)
 * so it's harness-agnostic: covers claude's Edit/Read/Write/Bash and pi's
 * lowercase read/write/bash alike. Both the HTML renderer here and ChatView's
 * ToolPart consume this, so the UI and the render log can't drift. */
export interface ToolView {
  /** Subject shown next to the tool name (path, command, …). */
  primary: string;
  /** Muted secondary detail (a Bash description, a Read line range). */
  secondary?: string;
  body: ToolBody;
}

export function toolView(
  part: Extract<ChatPart, { type: "tool" }>,
): ToolView {
  const a = (part.args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" ? v : undefined;
  const filePath = str(a.file_path) ?? str(a.path);
  const command = str(a.command);
  const description = str(a.description);
  const oldStr = str(a.old_string);
  const newStr = str(a.new_string);
  const content = str(a.content);
  const offset = num(a.offset);
  const limit = num(a.limit);

  // Edit-like: a string replacement in a file → show a diff.
  if (oldStr !== undefined && newStr !== undefined)
    return {
      primary: filePath ? shortenPath(filePath) : "edit",
      body: { kind: "diff", path: filePath, lines: lineDiff(oldStr, newStr) },
    };
  // Write-like: new file content → show it as a code block, not JSON.
  if (content !== undefined)
    return {
      primary: filePath ? shortenPath(filePath) : "write",
      body: { kind: "code", label: filePath, text: content },
    };
  // Bash-like: a shell command. When the harness supplies a description of the
  // command's intent (claude does; pi doesn't), lead the body with it as a
  // colon-terminated first line, then the command on the following lines.
  if (command !== undefined)
    return {
      primary: truncate(command.replace(/\s+/g, " "), 80),
      secondary: description,
      body: {
        kind: "code",
        text: description ? `${description}:\n${command}` : command,
      },
    };
  // Read-like: a path with an optional line range; output carries the content.
  // Skip when the call is really a search (Grep/Glob carry `path` alongside a
  // `pattern`/`query`) — those render better through the field-driven subject.
  if (
    filePath !== undefined &&
    str(a.pattern) === undefined &&
    str(a.query) === undefined
  ) {
    const range =
      offset !== undefined
        ? `lines ${offset}${limit !== undefined ? `–${offset + limit}` : "+"}`
        : limit !== undefined
          ? `first ${limit} lines`
          : undefined;
    return { primary: shortenPath(filePath), secondary: range, body: { kind: "none" } };
  }
  // Any other tool (ToolSearch, WebFetch/WebSearch, Agent, Skill, Grep/Glob,
  // Task*, NotebookEdit, MCP tools, …): derive a legible subject from a
  // recognized arg field instead of dumping raw JSON. Field-driven, not
  // tool-name-driven, so custom/MCP tools are covered too; full args stay in
  // the body.
  let primaryField: string | undefined;
  let primaryVal: string | undefined;
  for (const f of SUBJECT_FIELDS) {
    const v = str(a[f]);
    if (v !== undefined) {
      primaryField = f;
      primaryVal = v;
      break;
    }
  }
  // No known field? Use the first string value so the subject is still legible.
  if (primaryVal === undefined)
    for (const [k, v] of Object.entries(a))
      if (typeof v === "string") {
        primaryField = k;
        primaryVal = v;
        break;
      }
  let secondaryVal: string | undefined;
  for (const f of SECONDARY_FIELDS) {
    if (f === primaryField) continue;
    const v = str(a[f]);
    if (v !== undefined) {
      secondaryVal = v;
      break;
    }
  }
  return {
    primary: primaryVal !== undefined ? subject(primaryVal) : "",
    secondary: secondaryVal !== undefined ? subject(secondaryVal) : undefined,
    body:
      part.args !== undefined
        ? { kind: "json", text: JSON.stringify(part.args, null, 2) }
        : { kind: "none" },
  };
}

/** Fields (in priority order) whose value makes the best collapsed subject for
 * an otherwise-unrecognized tool. Ordered so the most identifying arg wins:
 * `query` (ToolSearch/WebSearch), `url` (WebFetch), `pattern` (Grep/Glob),
 * `skill` (Skill), `description`/`subagent_type` (Agent), `task_id` (Task*),
 * `notebook_path` (NotebookEdit), etc. */
const SUBJECT_FIELDS = [
  "query",
  "url",
  "pattern",
  "description",
  "prompt",
  "skill",
  "command_name",
  "name",
  "title",
  "subagent_type",
  "notebook_path",
  "task_id",
  "taskId",
  "id",
  "message",
];

/** A muted second detail, when present and distinct from the primary field. */
const SECONDARY_FIELDS = [
  "subagent_type",
  "path",
  "glob",
  "status",
  "args",
  "prompt",
  "description",
];

/** Collapse whitespace and shorten a raw arg value into a one-line subject:
 * path-like values get their last two segments, others are truncated to 80. */
function subject(v: string): string {
  const s = v.replace(/\s+/g, " ").trim();
  return s.includes("/") && !s.includes(" ")
    ? truncate(shortenPath(s), 80)
    : truncate(s, 80);
}

/** The HTML for a tool body (mirrors ChatView's ToolBody rendering). */
function renderToolBody(body: ToolBody): string {
  switch (body.kind) {
    case "none":
      return "";
    case "json":
      return `<pre class="chat-tool-args">${escapeHtml(body.text)}</pre>`;
    case "code":
      return (
        `<div class="chat-tool-body">` +
        (body.label
          ? `<div class="chat-tool-path">${escapeHtml(body.label)}</div>`
          : "") +
        `<pre class="chat-tool-code">${escapeHtml(body.text)}</pre></div>`
      );
    case "diff": {
      const cls = { " ": "diff-ctx", "+": "diff-add", "-": "diff-del" };
      // Spans are display:block (see CSS) so they line-break themselves — no
      // newline separators, which in a <pre> would double-space the diff.
      const lines = body.lines
        .map(
          (l) =>
            `<span class="${cls[l.sign]}">${escapeHtml(l.sign + " " + l.text)}</span>`,
        )
        .join("");
      return (
        `<div class="chat-tool-body">` +
        (body.path
          ? `<div class="chat-tool-path">${escapeHtml(body.path)}</div>`
          : "") +
        `<pre class="chat-tool-diff">${lines}</pre></div>`
      );
    }
  }
}

/** Status glyph shown on a tool part (matches ChatView's ToolPart). */
export function toolGlyph(status: string): string {
  return status === "done"
    ? "✓"
    : status === "error"
      ? "✕"
      : status === "running"
        ? "●"
        : "○";
}

/** One part's rendered form: which UI code path handles it, the top-level CSS
 * class the UI applies, and the HTML that path produces. */
export interface RenderedPart {
  type: ChatPart["type"];
  /** The React component / branch in ChatView that renders this part. */
  component: string;
  /** Top-level CSS class the UI applies to this part. */
  className: string;
  /** The HTML the UI produces for this part. */
  html: string;
}

/** A whole message's rendered form: the bubble class plus each part's HTML. */
export interface RenderedMessage {
  id: string;
  role: ChatMessage["role"];
  /** Class on the outer chat bubble. */
  bubbleClassName: string;
  parts: RenderedPart[];
  /** Concatenated part HTML — the bubble's inner HTML. */
  html: string;
}

/** One display group of an assistant message: a run of prose parts sharing a
 * bubble, or a single tool call standing as its own bubble. */
export type PartGroup =
  | { kind: "prose"; key: string; parts: ChatPart[] }
  | { kind: "tool"; key: string; part: Extract<ChatPart, { type: "tool" }> };

/** Split an assistant message into display groups. A turn is overwhelmingly
 * either prose or a tool call, so a tool gets its own bubble rather than a card
 * nested inside a near-empty one; a mixed turn just becomes several bubbles. */
export function groupParts(parts: ChatPart[]): PartGroup[] {
  const groups: PartGroup[] = [];
  parts.forEach((part, i) => {
    if (part.type === "tool") {
      // Keyed by toolId so React keeps its <details> open state as the turn grows.
      groups.push({ kind: "tool", key: `tool-${part.toolId}`, part });
      return;
    }
    const last = groups[groups.length - 1];
    if (last?.kind === "prose") last.parts.push(part);
    else groups.push({ kind: "prose", key: `prose-${i}`, parts: [part] });
  });
  return groups;
}

/** Render one part to the HTML the UI shows (see ChatView's Bubble/ToolPart).
 * `standalone` marks a tool that is its own bubble rather than nested in one
 * (the permission card embeds a nested one). */
export function renderPart(
  part: ChatPart,
  standalone = false,
  agents?: Record<string, AgentRun>,
): RenderedPart {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        component: "Markdown",
        className: "chat-md",
        html: `<div class="chat-md">${renderMarkdown(part.text)}</div>`,
      };
    case "thinking":
      // No reasoning text (claude) → a plain live "Thinking…" label; with text
      // (pi) → the collapsible transcript. Mirrors ChatView's Bubble. Note the
      // reducer strips empty thinking parts once the next part starts, so the
      // label form is mostly transient and rarely lands in the render log.
      return part.text.trim() === ""
        ? {
            type: "thinking",
            component: "ThinkingPart",
            className: "chat-thinking-label",
            html: `<div class="chat-thinking-label">Thinking…</div>`,
          }
        : {
            type: "thinking",
            component: "ThinkingPart",
            className: "chat-thinking",
            html:
              `<details class="chat-thinking"><summary>Thinking…</summary>` +
              `<div>${escapeHtml(part.text)}</div></details>`,
          };
    case "image":
      return {
        type: "image",
        component: "ImagePart",
        className: "chat-image",
        html:
          `<img class="chat-image" src="${escapeHtml(part.url)}"` +
          ` alt="${escapeHtml(part.name ?? "image")}" loading="lazy" />`,
      };
    case "tool": {
      const glyph = toolGlyph(part.status);
      const view = toolView(part);
      const summary =
        `<summary><span class="chat-tool-glyph">${glyph}</span>` +
        `<span class="chat-tool-name">${escapeHtml(part.name)}</span>` +
        (view.primary
          ? `<span class="chat-tool-preview">${escapeHtml(view.primary)}</span>`
          : "") +
        (view.secondary
          ? `<span class="chat-tool-desc">${escapeHtml(view.secondary)}</span>`
          : "") +
        `</summary>`;
      const cls = standalone ? "chat-tool standalone" : "chat-tool";
      // A tool that spawned a sub-agent shows that agent's own chat session
      // instead of its args and a <pre> of the report — the report is already
      // the last nested bubble (see the reducer's agent-done).
      // An empty run keeps the ordinary tool view: the panel would say nothing
      // while the tool's own output (e.g. a background agent's launch stub) is
      // the only information there is.
      const run = agents?.[part.toolId];
      const nested = run && (run.loading || run.state.messages.length > 0);
      const inner = nested
        ? renderAgentPanel(run, agents ?? {}, agentPrompt(part))
        : renderToolBody(view.body) +
          (part.output
            ? `<pre class="chat-tool-output">${escapeHtml(part.output)}</pre>`
            : "");
      return {
        type: "tool",
        component: nested ? "AgentPart" : "ToolPart",
        className: cls,
        html: `<details class="${cls}" data-status="${part.status}">${summary}${inner}</details>`,
      };
    }
  }
}

/** Render a whole message the way ChatView's Bubble does. User bubbles show the
 * joined text of their text parts as plain (escaped) text; assistant bubbles
 * render each part. */
/** The task a sub-agent was given, from the spawning tool's own args. Neither
 * the live stream nor `getSubagentMessages` carries the sub-agent's opening user
 * message (it's the sidechain root), so the panel would otherwise start
 * mid-conversation — we already hold the prompt right here. */
export function agentPrompt(part: Extract<ChatPart, { type: "tool" }>): string {
  const prompt = (part.args as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === "string" ? prompt : "";
}

/** The sub-agent's transcript as a scrollable panel of full turns, opening with
 * the task it was given. Recursion carries the flat root map through, so an
 * agent inside an agent nests again. */
function renderAgentPanel(
  run: AgentRun,
  agents: Record<string, AgentRun>,
  prompt = "",
): string {
  if (run.state.messages.length === 0)
    return `<div class="chat-agent empty">Loading transcript…</div>`;
  const opening = prompt
    ? `<div class="chat-turn user"><div class="chat-bubble user">${escapeHtml(prompt)}</div></div>`
    : "";
  const turns = run.state.messages
    .map((m) => {
      const rendered = renderMessage(m, agents);
      return m.role === "user"
        ? `<div class="chat-turn user"><div class="chat-bubble user">${rendered.html}</div></div>`
        : `<div class="chat-turn assistant">${rendered.html}</div>`;
    })
    .join("");
  return `<div class="chat-agent">${opening}${turns}</div>`;
}

export function renderMessage(
  message: ChatMessage,
  agents?: Record<string, AgentRun>,
): RenderedMessage {
  if (message.role === "user") {
    const text = message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    const images = message.parts.filter(
      (p): p is Extract<ChatPart, { type: "image" }> => p.type === "image",
    );
    const textHtml = text ? escapeHtml(text) : "";
    const imageHtml = images.map((p) => renderPart(p).html).join("");
    const html = textHtml + imageHtml;
    return {
      id: message.id,
      role: "user",
      bubbleClassName: "chat-bubble user",
      parts: [
        { type: "text", component: "Bubble", className: "chat-bubble user", html },
      ],
      html,
    };
  }
  // An assistant turn is a row of bubbles, not one: prose runs get a bubble
  // each, tool calls stand alone. `html` carries those wrappers so the render
  // log matches what ChatView actually shows.
  const parts: RenderedPart[] = [];
  const html = groupParts(message.parts)
    .map((g) => {
      if (g.kind === "tool") {
        const rendered = renderPart(g.part, true, agents);
        parts.push(rendered);
        return rendered.html;
      }
      const inner = g.parts
        .map((p) => {
          const rendered = renderPart(p);
          parts.push(rendered);
          return rendered.html;
        })
        .join("");
      return `<div class="chat-bubble assistant">${inner}</div>`;
    })
    .join("");
  return {
    id: message.id,
    role: "assistant",
    bubbleClassName: "chat-turn assistant",
    parts,
    html,
  };
}
