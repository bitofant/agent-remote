// Single source of truth for turning a ChatPart/ChatMessage into displayed HTML.
// ChatView imports these primitives so the UI can't drift; server/chatLog.ts
// calls renderMessage() to capture exactly what the UI produces.

import { Marked } from "marked";
import type { ChatMessage, ChatPart } from "./protocol.js";

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
  // Bash-like: a shell command.
  if (command !== undefined)
    return {
      primary: truncate(command.replace(/\s+/g, " "), 80),
      secondary: description,
      body: { kind: "code", text: command },
    };
  // Read-like: a path with an optional line range; output carries the content.
  if (filePath !== undefined) {
    const range =
      offset !== undefined
        ? `lines ${offset}${limit !== undefined ? `–${offset + limit}` : "+"}`
        : limit !== undefined
          ? `first ${limit} lines`
          : undefined;
    return { primary: shortenPath(filePath), secondary: range, body: { kind: "none" } };
  }
  // Unknown tool: keep the generic single-value preview, pretty-print the rest.
  return {
    primary: truncate(argsPreview(part.args).replace(/\s+/g, " "), 80),
    body:
      part.args !== undefined
        ? { kind: "json", text: JSON.stringify(part.args, null, 2) }
        : { kind: "none" },
  };
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

/** Render one part to the HTML the UI shows (see ChatView's Bubble/ToolPart). */
export function renderPart(part: ChatPart): RenderedPart {
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
      const body = renderToolBody(view.body);
      const output = part.output
        ? `<pre class="chat-tool-output">${escapeHtml(part.output)}</pre>`
        : "";
      return {
        type: "tool",
        component: "ToolPart",
        className: "chat-tool",
        html: `<details class="chat-tool" data-status="${part.status}">${summary}${body}${output}</details>`,
      };
    }
  }
}

/** Render a whole message the way ChatView's Bubble does. User bubbles show the
 * joined text of their text parts as plain (escaped) text; assistant bubbles
 * render each part. */
export function renderMessage(message: ChatMessage): RenderedMessage {
  if (message.role === "user") {
    const text = message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    return {
      id: message.id,
      role: "user",
      bubbleClassName: "chat-bubble user",
      parts: [
        { type: "text", component: "Bubble", className: "chat-bubble user", html: escapeHtml(text) },
      ],
      html: escapeHtml(text),
    };
  }
  const parts = message.parts.map(renderPart);
  return {
    id: message.id,
    role: "assistant",
    bubbleClassName: "chat-bubble assistant",
    parts,
    html: parts.map((p) => p.html).join(""),
  };
}
