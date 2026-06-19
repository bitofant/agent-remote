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

    // Touch scrolling: xterm's screen layer overlays the scroll viewport, so
    // swipes don't reach it natively (leaving only the sluggish wheel path).
    // Drive the viewport's scrollTop directly from the drag for 1:1 scrolling.
    const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
    let lastTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!viewport) return;
      const y = e.touches[0].clientY;
      viewport.scrollTop += lastTouchY - y;
      lastTouchY = y;
      e.preventDefault();
    };
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });

    // Re-apply the font size when crossing the mobile breakpoint (e.g. rotate).
    const onBreakpoint = () => {
      term.options.fontSize = fontSize();
      syncSize();
    };
    mobile.addEventListener("change", onBreakpoint);

    return () => {
      observer.disconnect();
      mobile.removeEventListener("change", onBreakpoint);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
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
