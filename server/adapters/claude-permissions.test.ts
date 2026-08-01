import { describe, expect, it } from "vitest";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  alwaysAllowUpdates,
  describeSuggestions,
  permissionOptions,
} from "./claude.js";

// What the SDK really hands canUseTool for a Bash call (captured live): three
// ALTERNATIVE updates, destined for the project's local settings file.
const dirUpdate: PermissionUpdate = {
  type: "addDirectories",
  directories: ["/tmp/scratch"],
  destination: "localSettings",
};
const modeUpdate: PermissionUpdate = {
  type: "setMode",
  mode: "acceptEdits",
  destination: "localSettings",
};

const rule = (
  toolName: string,
  ruleContent?: string,
  destination: PermissionUpdate["destination"] = "session",
): PermissionUpdate => ({
  type: "addRules",
  rules: [{ toolName, ruleContent }],
  behavior: "allow",
  destination,
});

// The SDK hands canUseTool the exact rule an "always allow" would install; the
// button must say which one (the TUI does) instead of a bare "Always allow".
describe("describeSuggestions", () => {
  it("renders a scoped rule as tool(content) plus its lifetime", () => {
    expect(describeSuggestions([rule("Bash", "git add:*")])).toBe(
      "Bash(git add:*) · this session",
    );
  });

  it("omits the parens when a rule covers a whole tool", () => {
    expect(describeSuggestions([rule("WebFetch")])).toBe(
      "WebFetch · this session",
    );
  });

  it("names the settings file when the rule is persisted", () => {
    expect(describeSuggestions([rule("Bash", "npm test:*", "projectSettings")])).toBe(
      "Bash(npm test:*) · saved to project settings",
    );
  });

  it("joins multiple rules", () => {
    expect(
      describeSuggestions([
        {
          type: "addRules",
          rules: [
            { toolName: "Bash", ruleContent: "git add:*" },
            { toolName: "Bash", ruleContent: "git commit:*" },
          ],
          behavior: "allow",
          destination: "session",
        },
      ]),
    ).toBe("Bash(git add:*), Bash(git commit:*) · this session");
  });

  it("describes only the rule, ignoring the alternative updates", () => {
    expect(
      describeSuggestions([
        rule("Bash", "touch notes.txt", "localSettings"),
        dirUpdate,
        modeUpdate,
      ]),
    ).toBe("Bash(touch notes.txt) · saved to local settings");
  });

  it("returns undefined when there is nothing legible to show", () => {
    expect(describeSuggestions([])).toBeUndefined();
    expect(describeSuggestions(undefined)).toBeUndefined();
    expect(
      describeSuggestions([
        { type: "removeRules", rules: [], behavior: "allow", destination: "session" },
      ]),
    ).toBeUndefined();
  });
});

// The SDK's suggestions are alternatives, so "always allow" must send back the
// rule ONLY — the rest would flip the session's mode / grant a directory.
describe("alwaysAllowUpdates", () => {
  it("keeps rule updates and drops mode/directory ones", () => {
    const r = rule("Bash", "touch notes.txt", "localSettings");
    expect(alwaysAllowUpdates([r, dirUpdate, modeUpdate])).toEqual([r]);
  });

  it("is empty when the SDK suggested no rule", () => {
    expect(alwaysAllowUpdates([dirUpdate, modeUpdate])).toEqual([]);
    expect(alwaysAllowUpdates(undefined)).toEqual([]);
  });
});

// Option `value`s are the adapter's decode keys and must stay stable no matter
// what the labels say; `intent` is what clients act on.
describe("permissionOptions", () => {
  it("offers no always-choice without suggestions", () => {
    const opts = permissionOptions("Bash", undefined);
    expect(opts.map((o) => o.value)).toEqual(["Allow", "Deny"]);
    expect(opts.map((o) => o.intent)).toEqual(["accept", "reject"]);
  });

  it("adds an always-choice detailing the rule when the SDK suggests one", () => {
    const opts = permissionOptions("Bash", [rule("Bash", "git add:*")]);
    expect(opts.map((o) => o.value)).toEqual(["Allow", "Always allow", "Deny"]);
    const always = opts[1];
    expect(always.intent).toBe("always");
    expect(always.label).toBe("Always allow");
    expect(always.detail).toBe("Bash(git add:*) · this session");
  });

  it("offers the mode flip for edit tools, whatever the SDK suggests", () => {
    const opts = permissionOptions("Edit", undefined);
    expect(opts.map((o) => o.value)).toEqual([
      "Allow",
      "Allow all edits",
      "Deny",
    ]);
    expect(opts[1].intent).toBe("always");
    expect(opts[1].detail).toBe("Auto-accept file edits · this session");
  });

  // No rule to install = the button would promise something it can't do.
  it("hides the always-choice when only mode/directory updates were suggested", () => {
    const opts = permissionOptions("Bash", [dirUpdate, modeUpdate]);
    expect(opts.map((o) => o.value)).toEqual(["Allow", "Deny"]);
  });
});
