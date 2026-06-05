import type { HarnessConfig } from "../config.js";
import type { HarnessAdapter, SessionOptions } from "./types.js";

// Adapter for a plain interactive shell — the "Terminal" option. The PTY gives
// the shell a tty, so the configured command (e.g. bash/zsh) starts
// interactively; the working directory is applied by the session manager.
export function createShellAdapter(cfg: HarnessConfig): HarnessAdapter {
  return {
    id: "terminal",
    name: "Terminal",
    invocation(_opts: SessionOptions): { command: string; args: string[] } {
      return { command: cfg.command, args: [] };
    },
  };
}
