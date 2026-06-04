import type { HarnessConfig } from "../config.js";
import type { HarnessAdapter, SessionOptions } from "./types.js";

// Adapter for pi (https://github.com/getpi/pi). Like Claude Code, pi runs its
// own interactive terminal UI, so the adapter only supplies the command.
export function createPiAdapter(cfg: HarnessConfig): HarnessAdapter {
  return {
    id: "pi",
    name: "pi",
    invocation(_opts: SessionOptions): { command: string; args: string[] } {
      return { command: cfg.command, args: [] };
    },
  };
}
