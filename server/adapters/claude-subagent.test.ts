import { describe, it, expect } from "vitest";
import { parseAgentMeta, subagentMeta } from "./claude.js";

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
