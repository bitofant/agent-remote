import type { ChatEffort } from "../../shared/protocol.js";

// Level vocabulary shared by claude (effort) and pi (thinking level).
const LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortOption(id: string): ChatEffort {
  return { id, label: LABELS[id] ?? id };
}
