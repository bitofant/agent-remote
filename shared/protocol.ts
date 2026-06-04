// WebSocket protocol shared by the Node backend and the React frontend.
// This is intentionally harness-agnostic: it describes sessions and terminal
// I/O, never anything specific to Claude Code, pi, or any other agent.

/** A harness the backend is configured to expose. */
export interface HarnessInfo {
  id: string;
  name: string;
}

/** A live or finished agent session. */
export interface SessionInfo {
  id: string;
  harnessId: string;
  harnessName: string;
  cwd: string;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
}

/** Messages the browser sends to the backend. */
export type ClientMessage =
  | { type: "start"; harnessId: string; cwd?: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "stop"; sessionId: string };

/** Messages the backend sends to the browser. */
export type ServerMessage =
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "started"; session: SessionInfo }
  | { type: "output"; sessionId: string; data: string }
  | { type: "exit"; sessionId: string; exitCode: number | null }
  | { type: "error"; message: string; sessionId?: string };
