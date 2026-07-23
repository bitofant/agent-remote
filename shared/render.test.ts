import { describe, it, expect } from "vitest";
import {
  lineDiff,
  renderMessage,
  renderPart,
  shortenPath,
  toolView,
} from "./render.js";
import type { ChatMessage, ChatPart } from "./protocol.js";

// Small helper to build a tool part with just the args we're exercising.
function toolPart(args: unknown): Extract<ChatPart, { type: "tool" }> {
  return { type: "tool", toolId: "t1", name: "Tool", args, output: "", status: "done" };
}

describe("shortenPath", () => {
  it("keeps short paths and trims long ones to the last two segments", () => {
    expect(shortenPath("file.ts")).toBe("file.ts");
    expect(shortenPath("dir/file.ts")).toBe("dir/file.ts");
    expect(shortenPath("/a/b/c/d/file.ts")).toBe("…/d/file.ts");
  });
});

describe("lineDiff", () => {
  it("marks added, removed, and unchanged lines", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { sign: " ", text: "a" },
      { sign: "-", text: "b" },
      { sign: "+", text: "B" },
      { sign: " ", text: "c" },
    ]);
  });
});

describe("toolView", () => {
  it("renders an edit (old/new_string) as a diff", () => {
    const view = toolView(
      toolPart({ file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" }),
    );
    expect(view.primary).toBe("…/src/app.ts");
    expect(view.body.kind).toBe("diff");
    if (view.body.kind === "diff") {
      expect(view.body.path).toBe("/repo/src/app.ts");
      expect(view.body.lines).toEqual([
        { sign: "-", text: "a" },
        { sign: "+", text: "b" },
      ]);
    }
  });

  it("renders a write (content) as a code block labelled with the path", () => {
    const view = toolView(toolPart({ file_path: "new.txt", content: "hello" }));
    expect(view.primary).toBe("new.txt");
    expect(view.body).toEqual({ kind: "code", label: "new.txt", text: "hello" });
  });

  it("renders a bash command, leading the body with its description", () => {
    const view = toolView(
      toolPart({ command: "npm   test", description: "run tests" }),
    );
    expect(view.primary).toBe("npm test"); // summary collapses whitespace
    expect(view.secondary).toBe("run tests");
    // …but the body keeps the command verbatim.
    expect(view.body).toEqual({ kind: "code", text: "run tests:\nnpm   test" });
  });

  it("renders a read as a path with a line-range subtitle and no body", () => {
    const view = toolView(toolPart({ file_path: "/x/y/z.ts", offset: 10, limit: 5 }));
    expect(view.primary).toBe("…/y/z.ts");
    expect(view.secondary).toBe("lines 10–15");
    expect(view.body).toEqual({ kind: "none" });
  });

  it("falls back to pretty JSON for an unknown tool", () => {
    const view = toolView(toolPart({ foo: 1, bar: 2 }));
    expect(view.body.kind).toBe("json");
    if (view.body.kind === "json") {
      expect(view.body.text).toBe(JSON.stringify({ foo: 1, bar: 2 }, null, 2));
    }
  });
});

describe("renderPart", () => {
  it("renders assistant text through markdown", () => {
    const part = renderPart({ type: "text", text: "**bold**" });
    expect(part.component).toBe("Markdown");
    expect(part.html).toContain("<strong>bold</strong>");
  });

  it("renders an empty thinking part as a transient label", () => {
    const part = renderPart({ type: "thinking", text: "   " });
    expect(part.className).toBe("chat-thinking-label");
    expect(part.html).toContain("Thinking…");
  });

  it("escapes raw HTML inside thinking text", () => {
    const part = renderPart({ type: "thinking", text: "<script>x</script>" });
    expect(part.html).toContain("&lt;script&gt;");
    expect(part.html).not.toContain("<script>");
  });

  it("carries the tool status onto the details element", () => {
    const part = renderPart(toolPart({ command: "ls" }));
    expect(part.component).toBe("ToolPart");
    expect(part.html).toContain('data-status="done"');
  });
});

describe("renderMessage", () => {
  it("renders a user bubble as escaped plain text (no markdown)", () => {
    const msg: ChatMessage = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "a <b> & **c**" }],
      createdAt: 0,
    };
    const rendered = renderMessage(msg);
    expect(rendered.bubbleClassName).toBe("chat-bubble user");
    expect(rendered.html).toBe("a &lt;b&gt; &amp; **c**");
  });

  it("concatenates each assistant part's html", () => {
    const msg: ChatMessage = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "hi" },
        toolPart({ command: "ls" }),
      ],
      createdAt: 0,
    };
    const rendered = renderMessage(msg);
    expect(rendered.parts).toHaveLength(2);
    expect(rendered.html).toBe(rendered.parts.map((p) => p.html).join(""));
  });
});
