import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "../../shared/protocol.js";
import { parsePiModelId } from "./pi.js";
import { piLocal, type PiDriver } from "./pi-local.testkit.ts";

// Live coverage for pi's model switcher: drives a REAL `pi --mode rpc`
// subprocess through the production SessionManager and asserts the catalog
// reaches ChatState and that a switch is confirmed by pi itself.
//
// Deliberately spends no tokens and needs no LLM endpoint — it never prompts;
// `get_available_models` / `set_model` are answered by pi locally. So unlike
// the other pi e2e files this one only skips when pi isn't configured.

const pi = piLocal();
const d = pi ? describe : describe.skip;

const isModels = (e: ChatEvent): e is Extract<ChatEvent, { type: "models" }> =>
  e.type === "models";
const isModelChanged = (
  e: ChatEvent,
): e is Extract<ChatEvent, { type: "model-changed" }> =>
  e.type === "model-changed";
const changedTo =
  (id: string) =>
  (e: ChatEvent): e is Extract<ChatEvent, { type: "model-changed" }> =>
    e.type === "model-changed" && e.current === id;
const isErrorNotice = (e: ChatEvent): e is Extract<ChatEvent, { type: "notice" }> =>
  e.type === "notice" && e.level === "error";

d("pi model switcher (live)", () => {
  function session(): PiDriver {
    return pi!.create(mkdtempSync(join(tmpdir(), "pi-model-")));
  }

  it("reports its model catalog at startup", async () => {
    const driver = session();
    try {
      const menu = await driver.waitFor(isModels);
      expect(menu.models.length).toBeGreaterThan(0);
      // Every entry must be addressable back to pi's (provider, modelId) pair,
      // and be grouped under the provider that serves it.
      for (const m of menu.models) {
        const target = parsePiModelId(m.id);
        expect(target, `unaddressable menu id: ${m.id}`).not.toBeNull();
        expect(m.group).toBe(target!.provider);
      }
      // Groups are contiguous — the UI derives its provider box from the order
      // they first appear, so a provider must never reappear later.
      const order = menu.models.map((m) => m.group as string);
      const firstSeen = [...new Set(order)];
      expect(order).toEqual(
        firstSeen.flatMap((g) => order.filter((x) => x === g)),
      );
    } finally {
      driver.close();
    }
  });

  it("switches model on request, confirmed by pi's own reply", async () => {
    const driver = session();
    try {
      const menu = await driver.waitFor(isModels);
      // Pick something other than whatever pi started on, so the confirmation
      // can't be mistaken for the startup state echoed back. (The startup
      // get_state races the catalog reply, so `current` may still be unknown
      // here — a confirmed switch is reported either way.)
      const started = await driver.waitFor(isModelChanged, 5_000).catch(() => null);
      const target = menu.models.find((m) => m.id !== started?.current)!;

      driver.act({ type: "set-model", model: target.id });
      await driver.waitFor(changedTo(target.id));
    } finally {
      driver.close();
    }
  });

  it("sections a provider into Enabled/Disabled from pi's project settings", async () => {
    // Two phases in one cwd: learn the real catalog, then curate one of its
    // models via a project-scoped `.pi/settings.json` and re-read it. Pins the
    // precedence rule (project settings replace global) end-to-end, which is
    // otherwise only inferred from pi's `deepMergeSettings` source.
    const cwd = mkdtempSync(join(tmpdir(), "pi-model-"));
    const first = pi!.create(cwd);
    let target: string;
    try {
      target = (await first.waitFor(isModels)).models[0].id;
    } finally {
      first.close();
    }

    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ enabledModels: [target] }),
    );

    const driver = pi!.create(cwd);
    try {
      const menu = await driver.waitFor(isModels);
      const chosen = menu.models.find((m) => m.id === target)!;
      expect(chosen.section).toBe("Enabled");
      // Everything else in that provider is Disabled, and Enabled sorts first.
      const peers = menu.models.filter((m) => m.group === chosen.group);
      expect(peers[0].id).toBe(target);
      expect(peers.slice(1).every((m) => m.section === "Disabled")).toBe(true);
      // Exactly one, which is what discriminates replace from merge: the global
      // settings curate their own models, so merging would enable those too.
      expect(menu.models.filter((m) => m.section === "Enabled")).toHaveLength(1);
      expect(new Set(menu.models.map((m) => m.section))).toEqual(
        new Set(["Enabled", "Disabled"]),
      );
    } finally {
      driver.close();
    }
  });

  it("surfaces a model pi refuses as an error notice", async () => {
    const driver = session();
    try {
      await driver.waitFor(isModels);
      driver.act({ type: "set-model", model: "vllm/no-such-model-here" });
      const notice = await driver.waitFor(isErrorNotice);
      expect(notice.text).toMatch(/no-such-model-here/);
    } finally {
      driver.close();
    }
  });
});
