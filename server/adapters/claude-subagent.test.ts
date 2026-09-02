import { describe, it, expect } from "vitest";
import {
  isHumanTurn,
  notificationToolId,
  parseAgentMeta,
  parseOrigins,
  subagentMeta,
  systemTurnText,
  taskLine,
} from "./claude.js";

// Pure gate for the sub-agent routing: which nested transcript an SDK message
// belongs to, and how the on-disk sidecar names the tool call it came from.

describe("subagentMeta", () => {
  it("returns null for main-thread messages", () => {
    expect(subagentMeta({ type: "assistant", parent_tool_use_id: null })).toBeNull();
    expect(subagentMeta({ type: "result" })).toBeNull();
    expect(subagentMeta(undefined)).toBeNull();
    // An empty string is not a tool id.
    expect(subagentMeta({ parent_tool_use_id: "" })).toBeNull();
  });

  it("routes by parent_tool_use_id on every message shape", () => {
    for (const type of ["assistant", "user", "stream_event", "tool_progress"])
      expect(subagentMeta({ type, parent_tool_use_id: "toolu_1" })).toEqual({
        parentToolId: "toolu_1",
        agentType: undefined,
        description: undefined,
      });
  });

  it("picks up the agent labels when the message carries them", () => {
    expect(
      subagentMeta({
        type: "assistant",
        parent_tool_use_id: "toolu_1",
        subagent_type: "Explore",
        task_description: "Find the reducer",
      }),
    ).toEqual({
      parentToolId: "toolu_1",
      agentType: "Explore",
      description: "Find the reducer",
    });
  });

  it("ignores non-string labels rather than passing junk through", () => {
    expect(
      subagentMeta({ parent_tool_use_id: "t", subagent_type: 7, task_description: {} }),
    ).toEqual({ parentToolId: "t", agentType: undefined, description: undefined });
  });
});

describe("parseAgentMeta", () => {
  it("reads the sidecar the CLI writes", () => {
    expect(
      parseAgentMeta(
        '{"agentType":"Explore","description":"Explore ChatView","toolUseId":"toolu_015e","spawnDepth":1}',
      ),
    ).toEqual({
      agentType: "Explore",
      description: "Explore ChatView",
      toolUseId: "toolu_015e",
    });
  });

  it("degrades to null on junk instead of throwing", () => {
    expect(parseAgentMeta("not json")).toBeNull();
    expect(parseAgentMeta("null")).toBeNull();
  });

  it("drops fields of the wrong type", () => {
    expect(parseAgentMeta('{"toolUseId":42,"agentType":"Plan"}')).toEqual({
      agentType: "Plan",
      description: undefined,
      toolUseId: undefined,
    });
  });
});

// The CLI injects non-human turns into the conversation as `user` entries. They
// must not be attributed to the user AND must not count as rewind targets — see
// isHumanTurn's comment for why the second is the dangerous half.
describe("isHumanTurn", () => {
  it("treats an absent origin as human (the SDK path stamps none)", () => {
    expect(isHumanTurn({ type: "user", message: { content: "hi" } })).toBe(true);
    expect(isHumanTurn({ origin: null })).toBe(true);
    expect(isHumanTurn(undefined)).toBe(true);
  });

  it("treats an explicit human origin as human", () => {
    expect(isHumanTurn({ origin: { kind: "human" } })).toBe(true);
  });

  it("excludes every non-human provenance", () => {
    for (const kind of [
      "task-notification",
      "peer",
      "channel",
      "coordinator",
      "observer",
      "observer-activity",
      "auto-continuation",
      "unclassified",
    ])
      expect(isHumanTurn({ origin: { kind } }), kind).toBe(false);
  });
});

describe("systemTurnText", () => {
  it("pulls the summary out of a task-notification block", () => {
    const raw =
      "<task-notification>\n<task-id>bxwkuksfa</task-id>\n" +
      "<tool-use-id>toolu_01</tool-use-id>\n<output-file>/tmp/x</output-file>\n" +
      '<status>completed</status>\n<summary>Background command "Final full e2e run" ' +
      "completed (exit code 0)</summary>\n</task-notification>";
    expect(
      systemTurnText({ origin: { kind: "task-notification" }, message: { content: raw } }),
    ).toBe('Background command "Final full e2e run" completed (exit code 0)');
  });

  it("prefers the SDK's decoded body when it has one (peer messages)", () => {
    expect(
      systemTurnText({
        origin: { kind: "peer", body: "hello from the other session" },
        message: { content: "<peer-envelope>…</peer-envelope>" },
      }),
    ).toBe("hello from the other session");
  });

  it("falls back to the raw text when there's nothing better", () => {
    expect(
      systemTurnText({ origin: { kind: "unclassified" }, message: { content: "  plain  " } }),
    ).toBe("plain");
  });
});

describe("taskLine", () => {
  it("uses the CLI's own summary sentence", () => {
    expect(taskLine({ summary: 'Background command "e2e" completed (exit code 0)', status: "completed" })).toBe(
      'Background command "e2e" completed (exit code 0)',
    );
  });

  it("names a non-completed status, which the summary may not", () => {
    expect(taskLine({ summary: "Build agent", status: "failed" })).toBe("Build agent (failed)");
  });

  it("falls back to the description, then to the bare status", () => {
    expect(taskLine({ description: "Explore the repo", status: "completed" })).toBe("Explore the repo");
    expect(taskLine({ status: "stopped" })).toBe("Background task stopped.");
    expect(taskLine({})).toBe("");
  });
});

describe("notificationToolId", () => {
  it("finds the tool call a notification belongs to", () => {
    expect(
      notificationToolId("<task-notification>\n<tool-use-id>toolu_01</tool-use-id>\n</task-notification>"),
    ).toBe("toolu_01");
  });

  it("returns undefined when the envelope names none", () => {
    expect(notificationToolId("just some prose")).toBeUndefined();
  });
});

describe("parseOrigins", () => {
  it("indexes provenance by uuid, ignoring entries that have none", () => {
    const jsonl = [
      '{"uuid":"a","type":"user","message":{"content":"hi"}}',
      '{"uuid":"b","type":"user","origin":{"kind":"task-notification"},"message":{"content":"x"}}',
      "not json at all",
      '{"uuid":"c","origin":{"kind":"peer","body":"hello"}}',
    ].join("\n");
    const origins = parseOrigins(jsonl);
    expect(origins.size).toBe(2);
    expect(origins.get("b")).toEqual({ kind: "task-notification" });
    expect(origins.get("c")).toEqual({ kind: "peer", body: "hello" });
    expect(origins.has("a")).toBe(false);
  });

  it("survives a truncated trailing line (the file is appended to live)", () => {
    expect(() => parseOrigins('{"uuid":"a","origin":{"kind":"peer"}}\n{"uuid":"b","ori')).not.toThrow();
    expect(parseOrigins('{"uuid":"a","origin":{"kind":"peer"}}\n{"uuid":"b","ori').size).toBe(1);
  });
});
