// Lifecycle coverage for chat-session exits: a deliberate stop must not report
// the harness's stderr tail as a failure, while a genuine crash still must.
// Spawns real (trivial) subprocesses through the production SessionManager with
// a fake adapter — no harness, no endpoint, no tokens — hence e2e, not the pure
// gate (which forbids processes).
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { SessionManager } from "./manager.js";
import type { HarnessAdapter } from "../adapters/types.js";

/** Chat harness that just runs `node -e <script>` and speaks no protocol. */
function fakeAdapter(script: string): Map<string, HarnessAdapter> {
  return new Map([
    [
      "fake",
      {
        id: "fake",
        name: "Fake",
        invocation: () => ({ command: process.execPath, args: ["-e", script] }),
        createChatTranslator: () => ({
          push: () => [],
          encode: () => ({ data: "", events: [] }),
        }),
      } satisfies HarnessAdapter,
    ],
  ]);
}

/** Start a fake chat session and resolve once it has exited. */
function run(script: string, act: (m: SessionManager, id: string) => void) {
  const manager = new SessionManager(fakeAdapter(script));
  return new Promise<SessionManager & { id: string }>((resolve) => {
    let id = "";
    manager.subscribe({
      onStarted() {},
      onOutput() {},
      onExit(exited) {
        if (exited === id) resolve(Object.assign(manager, { id }));
      },
    });
    id = manager.start("fake", { cwd: tmpdir() }).id;
    act(manager, id);
  });
}

const WARN = 'process.stderr.write("Warning: no project session found");';

describe("chat session exit notices", () => {
  it("stays quiet when we stopped the session ourselves", async () => {
    // Warns at startup (like pi's `--session-id` notice), then idles until killed.
    const m = await run(`${WARN} setInterval(() => {}, 1000);`, (manager, id) =>
      setTimeout(() => manager.stop(id), 300),
    );
    expect(m.chatState(m.id)?.notices).toEqual([]);
    // Drives the "closed" subtitle instead of SIGTERM's exit code.
    expect(m.sessionInfo(m.id)?.stopped).toBe(true);
  });

  it("still surfaces stderr when the harness dies on its own", async () => {
    const m = await run(
      `${WARN} setTimeout(() => process.exit(1), 150);`,
      () => {},
    );
    expect(m.chatState(m.id)?.notices.map((n) => n.level)).toEqual(["error"]);
    expect(m.chatState(m.id)?.notices[0].text).toContain("no project session");
    expect(m.sessionInfo(m.id)?.stopped).toBeFalsy();
    expect(m.sessionInfo(m.id)?.exitCode).toBe(1);
  });
});
