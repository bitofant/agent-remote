// Ad-hoc end-to-end smoke test for the claude-local adapter against vLLM.
// Builds the real adapter, drives a chat session, prints the ChatEvent stream.
// Run: npx tsx scripts/claude-local-smoke.ts
import { loadConfig } from "../server/config.js";
import { buildAdapters } from "../server/adapters/registry.js";

const config = loadConfig();
const adapters = buildAdapters(config);
const adapter = adapters.get("claude-local");
if (!adapter?.createChatSession) {
  console.error("claude-local adapter not present/enabled");
  process.exit(1);
}

const session = adapter.createChatSession({ cwd: process.cwd() });
let sawText = "";

session.start({
  onEvent(e) {
    if (e.type === "part-delta") sawText += e.delta;
    else if (e.type === "busy" && !e.busy) {
      // Turn finished — a persistent chat session won't self-exit, so close it.
      console.log("\n[turn complete] assistant:", JSON.stringify(sawText.trim()));
      session.close();
    } else if (e.type === "notice") {
      console.log(`[notice ${e.level}] ${e.text}`);
    } else {
      console.log(`[${e.type}]`);
    }
  },
  onExit(code) {
    console.log(`=== onExit(${code}) ===`);
    process.exit(sawText.trim() ? 0 : 1);
  },
});

session.action({ type: "prompt", text: "Reply with exactly: PONG" });

// Safety timeout.
const timer = setTimeout(() => {
  console.error("timeout — no completed turn");
  session.close();
}, 90_000);
timer.unref();
