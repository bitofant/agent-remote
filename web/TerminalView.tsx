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

    // Slightly smaller on mobile so terminal text matches the surrounding UI.
    const mobile = window.matchMedia("(max-width: 640px)");
    const fontSize = () => (mobile.matches ? 12 : 13);

    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: fontSize(),
      cursorBlink: true,
      theme: { background: "#0b0e14", foreground: "#bfbdb6" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    const { initial, unsubscribe } = client.subscribeOutput(
      sessionId,
      (data) => term.write(data),
      () => term.reset(),
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

    // Re-apply the font size when crossing the mobile breakpoint (e.g. rotate).
    const onBreakpoint = () => {
      term.options.fontSize = fontSize();
      syncSize();
    };
    mobile.addEventListener("change", onBreakpoint);

    return () => {
      observer.disconnect();
      mobile.removeEventListener("change", onBreakpoint);
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
