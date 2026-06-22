import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import type { Client } from "./client";

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
const isWord = (ch: string | undefined) => !!ch && !/\s/.test(ch);

// One xterm instance per session, kept mounted for the session's lifetime so
// scrollback survives tab switches. Inactive terminals are hidden with CSS
// rather than unmounted.
export function TerminalView({
  client,
  sessionId,
  active,
  selectMode,
  onEnterSelect,
  onExitSelect,
}: {
  client: Client;
  sessionId: string;
  active: boolean;
  // Touch text-selection. Off: drags scroll. On: drags select. A long-press
  // selects the word under the finger and flips the workspace into select mode.
  selectMode: boolean;
  onEnterSelect: () => void;
  onExitSelect: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  // Mirror the latest props into refs so the (sessionId-keyed) terminal effect's
  // long-lived touch handlers always see current values without re-running.
  const selectModeRef = useRef(selectMode);
  const onEnterRef = useRef(onEnterSelect);
  useEffect(() => {
    onEnterRef.current = onEnterSelect;
  });
  useEffect(() => {
    selectModeRef.current = selectMode;
    if (!selectMode) {
      termRef.current?.clearSelection();
      setHasSelection(false);
    }
  }, [selectMode]);

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
    termRef.current = term;

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
    term.onSelectionChange(() => setHasSelection(term.hasSelection()));

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

    // --- Touch: scroll, long-press-to-select, and drag-to-select ------------
    // xterm's selection is wired to mouse events that touch never synthesizes,
    // so we drive its public select() API from raw touch coords ourselves.
    const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
    const screenEl = () => container.querySelector<HTMLElement>(".xterm-screen");

    type Cell = { col: number; row: number };
    // Pixel → buffer cell. Cell pixel size isn't on the public API, so read it
    // off the render service (the one private hook in this file).
    const cellAt = (clientX: number, clientY: number): Cell | null => {
      const scr = screenEl();
      const dims = (term as unknown as { _core?: any })._core?._renderService
        ?.dimensions?.css?.cell;
      if (!scr || !dims?.width || !dims?.height) return null;
      const rect = scr.getBoundingClientRect();
      const col = clamp(
        Math.floor((clientX - rect.left) / dims.width),
        0,
        term.cols - 1,
      );
      const screenRow = clamp(
        Math.floor((clientY - rect.top) / dims.height),
        0,
        term.rows - 1,
      );
      return { col, row: term.buffer.active.viewportY + screenRow };
    };

    const selectWordAt = ({ col, row }: Cell): boolean => {
      const line = term.buffer.active.getLine(row);
      if (!line) return false;
      const text = line.translateToString(false);
      if (!isWord(text[col])) return false;
      let start = col;
      let end = col;
      while (start > 0 && isWord(text[start - 1])) start--;
      while (end < text.length - 1 && isWord(text[end + 1])) end++;
      term.select(start, row, end - start + 1);
      return true;
    };

    // Contiguous run from anchor to current cell, in reading order.
    const selectRange = (a: Cell, b: Cell) => {
      const [s, e] =
        a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
      const length = (e.row - s.row) * term.cols + (e.col - s.col) + 1;
      term.select(s.col, s.row, length);
    };

    let lastTouchY = 0;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let anchor: Cell | null = null;
    let longPressTimer: number | undefined;
    const clearTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = undefined;
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      lastTouchY = t.clientY;
      startX = t.clientX;
      startY = t.clientY;
      moved = false;
      anchor = selectModeRef.current ? cellAt(t.clientX, t.clientY) : null;
      clearTimer();
      longPressTimer = window.setTimeout(() => {
        const cell = cellAt(startX, startY);
        if (cell && selectWordAt(cell)) {
          anchor = cell;
          // Flip optimistically so a continued drag extends the selection
          // before React re-renders with the new mode.
          selectModeRef.current = true;
          onEnterRef.current();
        }
      }, 450);
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!moved && Math.hypot(t.clientX - startX, t.clientY - startY) > 10) {
        moved = true;
        clearTimer(); // a drag isn't a long-press
      }
      if (selectModeRef.current) {
        // Block xterm's own touch-scroll listener (on the inner .xterm-screen)
        // from also scrolling: this capture-phase handler runs first, and
        // stopPropagation keeps the event from ever reaching it.
        e.preventDefault();
        e.stopPropagation();
        const cur = cellAt(t.clientX, t.clientY);
        if (anchor && cur) selectRange(anchor, cur);
        return;
      }
      // Normal mode: drive viewport scroll directly for 1:1 swipe scrolling.
      if (viewport) {
        viewport.scrollTop += lastTouchY - t.clientY;
        lastTouchY = t.clientY;
        e.preventDefault();
      }
    };

    const onTouchEnd = () => clearTimer();

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    // Capture phase so select mode can stopPropagation before xterm's own
    // touch-scroll listener (bound to the inner .xterm-screen) ever runs.
    container.addEventListener("touchmove", onTouchMove, {
      passive: false,
      capture: true,
    });
    container.addEventListener("touchend", onTouchEnd, { passive: true });

    // Re-apply the font size when crossing the mobile breakpoint (e.g. rotate).
    const onBreakpoint = () => {
      term.options.fontSize = fontSize();
      syncSize();
    };
    mobile.addEventListener("change", onBreakpoint);

    return () => {
      clearTimer();
      observer.disconnect();
      mobile.removeEventListener("change", onBreakpoint);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove, { capture: true });
      container.removeEventListener("touchend", onTouchEnd);
      unsubscribe();
      renderer.dispose(); // free the GPU/canvas context before the terminal
      term.dispose();
      termRef.current = null;
    };
  }, [client, sessionId]);

  const copySelection = async () => {
    const term = termRef.current;
    const text = term?.getSelection();
    if (text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard may be unavailable (insecure context); leave the selection
        // so the user can fall back to a manual copy.
        return;
      }
    }
    onExitSelect();
  };

  return (
    <>
      <div
        ref={containerRef}
        className="terminal"
        style={{ display: active ? "block" : "none" }}
      />
      {active && selectMode && hasSelection && (
        <button
          className="copy-pill"
          // Don't steal focus from the terminal (keeps the keyboard up).
          onMouseDown={(e) => e.preventDefault()}
          onClick={copySelection}
        >
          Copy
        </button>
      )}
    </>
  );
}
