// Nested-session lifecycle (auto-PR's `/pr` agent): closing a nested session only
// hides it while its parent lives; removing the parent hard-removes it. Real
// (trivial) subprocesses via a fake adapter — no harness/endpoint/tokens — hence
// e2e, not the pure gate.
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { SessionManager } from "./manager.js";
import type { HarnessAdapter } from "../adapters/types.js";

const IDLE = "setInterval(() => {}, 1000);";

function manager() {
  const adapters = new Map<string, HarnessAdapter>([
    [
      "fake",
      {
        id: "fake",
        name: "Fake",
        invocation: () => ({ command: process.execPath, args: ["-e", IDLE] }),
        createChatTranslator: () => ({
          push: () => [],
          encode: () => ({ data: "", events: [] }),
        }),
      } satisfies HarnessAdapter,
    ],
  ]);
  const m = new SessionManager(adapters);
  const hidden: string[] = [];
  const removed: string[] = [];
  const exited = new Set<string>();
  m.subscribe({
    onStarted() {},
    onOutput() {},
    onExit: (id) => void exited.add(id),
    onHidden: (id) => void hidden.push(id),
    onRemoved: (id) => void removed.push(id),
  });
  return { m, hidden, removed, exited };
}

const waitExit = async (exited: Set<string>, id: string) => {
  for (let i = 0; i < 50 && !exited.has(id); i++)
    await new Promise((r) => setTimeout(r, 50));
  return exited.has(id);
};

describe("nested session lifecycle", () => {
  it("closing a nested session hides it, keeping it running and its state", () => {
    const { m, hidden, removed } = manager();
    const parent = m.start("fake", { cwd: tmpdir() }).id;
    const child = m.start("fake", { cwd: tmpdir(), parent }).id;
    expect(m.sessionInfo(child)?.parentId).toBe(parent);

    m.remove(child);
    expect(hidden).toEqual([child]);
    expect(removed).toEqual([]);
    expect(m.sessionInfo(child)?.hidden).toBe(true);
    expect(m.sessionInfo(child)?.status).toBe("running");
    expect(m.chatState(child)).toBeDefined();
    // Reconnect snapshot still carries it (flagged), so inline views survive a reload.
    expect(m.list().find((s) => s.id === child)?.hidden).toBe(true);

    m.remove(child); // idempotent
    expect(hidden).toEqual([child]);
    m.remove(parent);
  });

  it("removing the parent hard-removes its nested sessions", async () => {
    const { m, removed, exited } = manager();
    const parent = m.start("fake", { cwd: tmpdir() }).id;
    const child = m.start("fake", { cwd: tmpdir(), parent }).id;
    m.remove(child);

    m.remove(parent);
    expect(removed).toEqual([parent, child]);
    expect(m.sessionInfo(child)).toBeUndefined();
    expect(await waitExit(exited, child)).toBe(true);
  });

  it("a nested session whose parent is gone is removed outright", () => {
    const { m, hidden, removed } = manager();
    const child = m.start("fake", { cwd: tmpdir(), parent: "no-such-session" }).id;
    m.remove(child);
    expect(hidden).toEqual([]);
    expect(removed).toEqual([child]);
  });
});
