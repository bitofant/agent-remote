// Live coverage for claude's reasoning-effort picker: the catalog's
// per-model `supportedEffortLevels` reach an `efforts` event, and a switch is
// applied via `applyFlagSettings` (confirmed by `effort-changed`) without
// breaking the next turn. Zero Claude tokens (claude-local → vLLM); self-skips
// unless claude-local is enabled and its endpoint answers.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../shared/protocol.js";
import { ChatDriver, claudeLocal, endpointUp } from "./claude-local.testkit.js";

const local = claudeLocal();
const up = await endpointUp(local?.baseUrl);

type Efforts = Extract<ChatEvent, { type: "efforts" }>;

describe.skipIf(!local || !up)("claude-local: reasoning effort", () => {
  it("offers the model's effort levels and applies a switch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-remote-e2e-"));
    const driver = new ChatDriver(local!.create(dir)).start();
    try {
      const efforts = () =>
        driver.events.filter((e): e is Efforts => e.type === "efforts").at(-1);
      // Emitted right after the catalog, whether or not the model has levels.
      await driver.waitFor(() => !!efforts(), 30_000, "no efforts event");
      const menu = efforts()!;
      if (menu.efforts.length === 0) return; // model reports no effort support
      expect(menu.efforts[0].id).toBe("default");
      expect(menu.current).toBe("default");

      const target = menu.efforts.find((e) => e.id === "low") ?? menu.efforts[1];
      driver.act({ type: "set-effort", effort: target.id });
      await driver.waitFor(
        () =>
          driver.events.some(
            (e) => e.type === "effort-changed" && e.current === target.id,
          ),
        15_000,
        "effort switch not confirmed",
      );
      expect(
        driver.events.some((e) => e.type === "notice" && e.level === "error"),
      ).toBe(false);
      // The override must not break a turn.
      await driver.prompt("What is 2 + 2? Answer with just the number.", 90_000);
    } finally {
      driver.close();
    }
  });
});
