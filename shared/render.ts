// Single source of truth for how a normalized ChatPart/ChatMessage becomes the
// HTML the browser shows. ChatView imports the primitives here (md, escapeHtml,
// argsPreview, …) so the UI and this module never drift; the server-side chat
// render-log (server/chatLog.ts) calls renderMessage() to capture *exactly* what
// the UI produces alongside the original normalized data. Harness-agnostic: it
// only knows the shared chat schema, never any agent's wire format.

import { Marked } from "marked";
import type { ChatMessage, ChatPart } from "./protocol.js";

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Markdown renderer for assistant text. Raw HTML in the model's output is
// escaped (shown literally) rather than injected into the page.
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
    // Common case: a single primary argument (e.g. bash's `command`) reads
    // better than JSON.
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
      return {
        type: "thinking",
        component: "ThinkingPart",
        className: "chat-thinking",
        html:
          `<details class="chat-thinking"><summary>Thinking…</summary>` +
          `<div>${escapeHtml(part.text)}</div></details>`,
      };
    case "tool": {
      const glyph = toolGlyph(part.status);
      const preview = truncate(argsPreview(part.args).replace(/\s+/g, " "), 80);
      const summary =
        `<summary><span class="chat-tool-glyph">${glyph}</span>` +
        `<span class="chat-tool-name">${escapeHtml(part.name)}</span>` +
        (preview
          ? `<span class="chat-tool-preview">${escapeHtml(preview)}</span>`
          : "") +
        `</summary>`;
      const args =
        part.args !== undefined
          ? `<pre class="chat-tool-args">${escapeHtml(
              JSON.stringify(part.args, null, 2),
            )}</pre>`
          : "";
      const output = part.output
        ? `<pre class="chat-tool-output">${escapeHtml(part.output)}</pre>`
        : "";
      return {
        type: "tool",
        component: "ToolPart",
        className: "chat-tool",
        html: `<details class="chat-tool" data-status="${part.status}">${summary}${args}${output}</details>`,
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
