import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Client } from "./client";

// One xterm instance per session, kept mounted for the session's lifetime so
// scrollback survives tab switches. Inactive terminals are hidden with CSS
// rather than unmounted.
export function TerminalView({
  client,
  sessionId,
  active,
}: {
  client: Client;
  sessionId: string;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#0b0e14", foreground: "#bfbdb6" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    const { initial, unsubscribe } = client.subscribeOutput(sessionId, (data) =>
      term.write(data),
    );
    if (initial) term.write(initial);

    term.onData((data) => client.input(sessionId, data));

    const syncSize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      client.resize(sessionId, term.cols, term.rows);
    };
    syncSize();

    // Refit when the container resizes, including when it becomes visible.
    const observer = new ResizeObserver(syncSize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      unsubscribe();
      term.dispose();
    };
  }, [client, sessionId]);

  return (
    <div
      ref={containerRef}
      className="terminal"
      style={{ display: active ? "block" : "none" }}
    />
  );
}
