// Live end-to-end test of the permission card's "Always allow" choice against
// the claude-local harness (see CLAUDE.md). A Bash write-command prompts in the
// default permission mode (read-only/safe ones are auto-allowed), and the SDK
// hands canUseTool the scoped rule an "always" would install. This pins:
//   (a) the option set / stable `value` decode keys / intents,
//   (b) that the button names the rule it installs and where it's saved, and
//   (c) that choosing it makes the CLI actually write that rule to the
//       project's permissions file (`.claude/settings.local.json`) — i.e. the
//       promise in (b) is kept, not just rendered.
//
// Zero Claude tokens (local endpoint), but a real model call: excluded from
// `npm test`, self-skips unless claude-local is enabled and answering.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  claudeLocal,
  endpointUp,
  settle,
  ChatDriver,
} from "./claude-local.testkit.js";

const DIR = mkdtempSync(join(tmpdir(), "agent-remote-e2e-"));

const local = claudeLocal();
const up = await endpointUp(local?.baseUrl);

describe.skipIf(!local || !up)("claude-local: always-allow", () => {
  it("names the rule it installs, and installs it", async () => {
    const driver = new ChatDriver(local!.create(DIR)).start();
    // `touch` is not on the CLI's safe-command list, so it prompts. (`echo`
    // is auto-allowed and never reaches canUseTool — don't use it here.)
    driver.send("Use the Bash tool to run exactly `touch notes.txt`.");
    await driver.waitFor(
      () => driver.permissions.some((r) => r.tool?.name === "Bash"),
      110_000,
      "no Bash permission was requested",
    );
    const card = driver.permissions.find((r) => r.tool?.name === "Bash")!;

    // (a) Stable decode keys + semantics, whatever the labels say.
    const options = card.options ?? [];
    expect(options.map((o) => o.value)).toEqual(["Allow", "Always allow", "Deny"]);
    expect(options.map((o) => o.intent)).toEqual(["accept", "always", "reject"]);

    // (b) The always-choice says which rule it installs, and where it's saved.
    const always = options.find((o) => o.intent === "always")!;
    expect(always.detail, "always-allow carried no rule detail").toBeTruthy();
    expect(always.detail).toContain("Bash(touch notes.txt)");
    expect(always.detail).toMatch(/ · (this session|saved to .+ settings)$/);

    // The driver auto-approved this card with "Allow"; answer again with the
    // always-choice on the next one, then drive a second identical command.
    // (Re-answering the same id is a no-op — the resolver is already consumed.)
    driver.answerWith(always.value);
    await settle(2000);
    await driver.prompt(
      "Use the Bash tool to run exactly `touch notes2.txt`.",
      110_000,
    );
    await settle(2000);
    driver.close();

    // (c) The CLI wrote the rule to the project's permissions file.
    const settingsPath = join(DIR, ".claude", "settings.local.json");
    expect(
      existsSync(settingsPath),
      `no permissions file at ${settingsPath}`,
    ).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions?: { allow?: string[] };
    };
    expect(settings.permissions?.allow ?? []).toContain("Bash(touch notes2.txt)");
  }, 250_000);
});
