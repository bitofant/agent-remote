import type { HarnessConfig } from "../config.js";
import type { HarnessAdapter, SessionOptions } from "./types.js";

// Adapter for Claude Code. The interactive CLI drives its own terminal UI, so
// we simply launch the configured command inside a PTY and let it take over.
export function createClaudeAdapter(cfg: HarnessConfig): HarnessAdapter {
  return {
    id: "claude",
    name: "Claude Code",
    invocation(_opts: SessionOptions): { command: string; args: string[] } {
      return { command: cfg.command, args: [] };
    },
  };
}
