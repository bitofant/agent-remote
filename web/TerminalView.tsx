import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
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
      allowProposedApi: true, // required by the unicode11 addon
      theme: { background: "#0b0e14", foreground: "#bfbdb6" },
    });

    // Wide-char width calc: agents emit box-drawing + emoji that the default
    // tables size wrong, corrupting TUI layout. unicode11 fixes the widths.
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon());

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // GPU rendering is the big smoothness/perf win over the default DOM
    // renderer. Prefer WebGL; fall back to 2D canvas if WebGL is unavailable
    // or its context is lost (some mobile GPUs drop it under memory pressure).
    let renderer: WebglAddon | CanvasAddon;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        renderer = new CanvasAddon();
        term.loadAddon(renderer);
      });
      term.loadAddon(webgl);
      renderer = webgl;
    } catch {
      renderer = new CanvasAddon();
      term.loadAddon(renderer);
    }

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
      renderer.dispose(); // free the GPU/canvas context before the terminal
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
