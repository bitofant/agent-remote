import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  FolderInfo,
  HarnessInfo,
  SessionInfo,
} from "../shared/protocol";
import { Client, type CtrlMode } from "./client";
import { TerminalView } from "./TerminalView";
import { Login } from "./Login";
import { fetchMe, logout } from "./auth";

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// Tracks the on-screen keyboard via the visual viewport. `height` is the
// visible height the app is pinned to while the keyboard is up. `open` stays
// false on desktop, so keyboard-gated UI never shows there.
function useKeyboard(): { open: boolean; height: number } {
  const [state, setState] = useState({ open: false, height: 0 });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // Largest viewport height seen = the no-keyboard height; compare against it
    // so detection works whether the keyboard shrinks the visual or the layout
    // viewport.
    let maxHeight = Math.max(vv.height, window.innerHeight);
    const onChange = () => {
      maxHeight = Math.max(maxHeight, vv.height);
      const open = maxHeight - vv.height > 120;
      setState({ open, height: Math.round(vv.height) });
    };
    onChange();
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, []);
  return state;
}

// Material Design `keyboard_arrow_*` icon paths (24x24 viewBox). Drawn with
// `currentColor` so they inherit the button's text/accent color.
const ARROW_PATHS = {
  up: "M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z",
  down: "M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z",
  left: "M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z",
  right: "M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z",
} as const;

// Material icons used on the group toggle: a d-pad (positional keys) and a
// keyboard (everything else).
const NAV_ICON =
  "M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2l-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H8l5 5 5-5h-3v-3z";
const KEYBOARD_ICON =
  "M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z";
// Material `select_all` (dashed marquee): toggles touch text-selection mode.
const SELECT_ICON =
  "M3 5h2V3c-1.1 0-2 .9-2 2zm0 8h2v-2H3v2zm4 8h2v-2H7v2zM3 9h2V7H3v2zm10-6h-2v2h2V3zm6 0v2h2c0-1.1-.9-2-2-2zM5 21v-2H3c0 1.1.9 2 2 2zm-2-4h2v-2H3v2zM9 3H7v2h2V3zm2 18h2v-2h-2v2zm8-8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2zm0-12h2V7h-2v2zm0 8h2v-2h-2v2zm-4 4h2v-2h-2v2zm0-16h2V3h-2v2z";

function Icon({ path }: { path: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d={path} />
    </svg>
  );
}

function Arrow({ dir }: { dir: keyof typeof ARROW_PATHS }) {
  return <Icon path={ARROW_PATHS[dir]} />;
}

// Keys a mobile keyboard usually lacks but terminals need, split into two
// switchable groups: positional (arrows) and everything else. A plain key sends
// its `seq`; the `toggle` key (Ctrl) instead arms a sticky modifier applied to
// the next keystroke (from the keyboard or another on-screen key).
type KeyDef = { label: ReactNode; aria: string; seq?: string; toggle?: boolean };

type KeyGroup = "keys" | "arrows";

const KEY_GROUPS: Record<KeyGroup, KeyDef[]> = {
  keys: [
    { label: "Esc", aria: "Escape", seq: "\x1b" },
    { label: "Tab", aria: "Tab", seq: "\t" },
    { label: "Ctrl", aria: "Control", toggle: true },
    { label: "⏎", aria: "Newline", seq: "\n" },
    { label: "/", aria: "Slash", seq: "/" },
    { label: "`", aria: "Backtick", seq: "`" },
  ],
  arrows: [
    { label: <Arrow dir="up" />, aria: "Up arrow", seq: "\x1b[A" },
    { label: <Arrow dir="down" />, aria: "Down arrow", seq: "\x1b[B" },
    { label: <Arrow dir="left" />, aria: "Left arrow", seq: "\x1b[D" },
    { label: <Arrow dir="right" />, aria: "Right arrow", seq: "\x1b[C" },
    { label: "Home", aria: "Home", seq: "\x1b[H" },
    { label: "End", aria: "End", seq: "\x1b[F" },
  ],
};

export function App() {
  // Auth gate: undefined = still checking, null = logged out, string = username.
  const [user, setUser] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    fetchMe().then(setUser);
  }, []);

  if (user === undefined) return <div className="app loading" />;
  if (user === null) {
    return <Login onAuthed={() => fetchMe().then(setUser)} />;
  }
  return <Workspace username={user} onLogout={() => setUser(null)} />;
}

function Workspace({
  username,
  onLogout,
}: {
  username: string;
  onLogout: () => void;
}) {
  const client = useMemo(() => new Client(), []);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  // Which session is shown for each folder.
  const [activeSession, setActiveSession] = useState<Record<string, string>>({});
  const [newFolder, setNewFolder] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Off-canvas sidebar drawer (mobile only; ignored on desktop via CSS).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const keyboard = useKeyboard();
  const [ctrlMode, setCtrlMode] = useState<CtrlMode>("off");
  const [keyGroup, setKeyGroup] = useState<KeyGroup>("keys");
  // Touch text-selection mode, applied to the active terminal.
  const [selectMode, setSelectMode] = useState(false);
  const knownIds = useRef<Set<string>>(new Set());
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    client.connect();
    fetch("/api/harnesses")
      .then((r) => r.json())
      .then(setHarnesses)
      .catch(() => setHarnesses([]));
    const offSessions = client.onSessions(setSessions);
    const offFolders = client.onFolders(setFolders);
    const offCtrl = client.onCtrl(setCtrlMode);
    return () => {
      offSessions();
      offFolders();
      offCtrl();
      client.disconnect();
    };
  }, [client]);

  // Auto-select newly created sessions: focus their folder and make them active.
  useEffect(() => {
    let created: SessionInfo | null = null;
    for (const s of sessions) {
      if (!knownIds.current.has(s.id)) {
        knownIds.current.add(s.id);
        created = s;
      }
    }
    if (created) {
      const folder = created.cwd;
      setActiveFolder(folder);
      setActiveSession((prev) => ({ ...prev, [folder]: created!.id }));
    }
  }, [sessions]);

  // Default to the most-recent folder once folders arrive.
  useEffect(() => {
    if (activeFolder === null && folders.length > 0) {
      setActiveFolder(folders[0].path);
    }
  }, [folders, activeFolder]);

  // Close the add-session dropdown on an outside click.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addMenuOpen]);

  const openFolder = (path: string) => {
    setActiveFolder(path);
    setSelectorOpen(false);
    setSidebarOpen(false);
    client.addFolder(path); // bump recency
  };

  const submitNewFolder = () => {
    const path = newFolder.trim();
    if (!path) return;
    client.addFolder(path);
    setActiveFolder(path);
    setNewFolder("");
    setSidebarOpen(false);
  };

  const handleLogout = async () => {
    await logout();
    client.disconnect();
    onLogout();
  };

  const sessionsInFolder = sessions.filter((s) => s.cwd === activeFolder);
  const activeSessionId =
    activeFolder !== null
      ? (activeSession[activeFolder] ??
        sessionsInFolder[sessionsInFolder.length - 1]?.id ??
        null)
      : null;

  // Selection mode is per active terminal; reset it when the active one changes.
  useEffect(() => {
    setSelectMode(false);
  }, [activeSessionId]);

  return (
    <div
      className="app"
      // While the keyboard is up, pin the app to the visible (visual viewport)
      // height so its content can't be panned under the keyboard. dvh alone
      // doesn't shrink for the keyboard, which let the title bar scroll away.
      style={keyboard.open ? { height: keyboard.height } : undefined}
    >
      <button
        className="menu-toggle"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open menu"
      >
        ☰
      </button>
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <h1>agent-remote</h1>
          <button
            className="logout-button"
            onClick={handleLogout}
            title={`Log out ${username}`}
          >
            Log out
          </button>
        </div>

        <section>
          <label className="field-label">Add folder</label>
          <input
            className="cwd-input"
            placeholder="/path/to/folder"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitNewFolder()}
          />
        </section>

        <section className="folder-list">
          <label className="field-label">Folders</label>
          {folders.length === 0 && (
            <p className="muted">No folders yet. Add one above.</p>
          )}
          {folders.map((f) => (
            <button
              key={f.path}
              className={`folder-item ${f.path === activeFolder ? "active" : ""}`}
              onClick={() => openFolder(f.path)}
              title={f.path}
            >
              <span className="folder-name">{folderName(f.path)}</span>
              <span className="folder-path">{f.path}</span>
            </button>
          ))}
        </section>
      </aside>

      <main className="main">
        {activeFolder === null ? (
          <div className="empty-state">
            Add or select a folder to get started.
          </div>
        ) : (
          <>
            <div className="folder-header">
              <span className="folder-header-path" title={activeFolder}>
                {activeFolder}
              </span>
              <div className="header-actions">
                <button
                  className={`header-icon-button ${selectMode ? "active" : ""}`}
                  onClick={() => setSelectMode((m) => !m)}
                  aria-pressed={selectMode}
                  title="Select text"
                >
                  <Icon path={SELECT_ICON} />
                </button>
                <div className="add-session" ref={addMenuRef}>
                  <button
                    className="add-session-button"
                    onClick={() => setAddMenuOpen((o) => !o)}
                    title="New session"
                  >
                    +
                  </button>
                {addMenuOpen && (
                  <div className="add-session-menu">
                    {harnesses.length === 0 && (
                      <div className="add-session-empty">No harnesses enabled.</div>
                    )}
                    {harnesses.map((h) => (
                      <button
                        key={h.id}
                        className="add-session-option"
                        onClick={() => {
                          client.start(h.id, activeFolder);
                          setAddMenuOpen(false);
                        }}
                      >
                        {h.name}
                      </button>
                    ))}
                  </div>
                )}
                </div>
              </div>
            </div>

            <div className="session-selector">
              <button
                className="session-selector-header"
                onClick={() => setSelectorOpen((o) => !o)}
              >
                <span className="caret">{selectorOpen ? "▾" : "▸"}</span>
                {sessionsInFolder.length}{" "}
                {sessionsInFolder.length === 1 ? "session" : "sessions"}
              </button>
              {selectorOpen && (
                <div className="session-list">
                  {sessionsInFolder.length === 0 && (
                    <p className="muted">No sessions yet. Use + to add one.</p>
                  )}
                  {sessionsInFolder.map((s) => (
                    <button
                      key={s.id}
                      className={`session-item ${s.id === activeSessionId ? "active" : ""}`}
                      onClick={() => {
                        setActiveSession((prev) => ({
                          ...prev,
                          [activeFolder]: s.id,
                        }));
                        setSelectorOpen(false);
                      }}
                    >
                      <span className={`status-dot ${s.status}`} />
                      <span className="session-name">{s.harnessName}</span>
                      <span className="session-meta">
                        {s.status === "exited"
                          ? `exited (${s.exitCode ?? "?"})`
                          : "running"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="session-content">
              {sessionsInFolder.length === 0 && (
                <div className="empty-state">
                  No sessions in this folder. Use + to start one.
                </div>
              )}
              {/* All sessions stay mounted for scrollback; only the active one
                  in the active folder is visible. */}
              {sessions.map((s) => (
                <TerminalView
                  key={s.id}
                  client={client}
                  sessionId={s.id}
                  active={s.id === activeSessionId}
                  selectMode={s.id === activeSessionId && selectMode}
                  onEnterSelect={() => setSelectMode(true)}
                  onExitSelect={() => setSelectMode(false)}
                />
              ))}
            </div>

            {activeSessionId !== null && keyboard.open && (
              <div className="key-bar">
                <button
                  className="key-button key-bar-toggle"
                  aria-label={
                    keyGroup === "keys" ? "Show arrow keys" : "Show other keys"
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    setKeyGroup((g) => (g === "keys" ? "arrows" : "keys"))
                  }
                >
                  <Icon path={keyGroup === "keys" ? NAV_ICON : KEYBOARD_ICON} />
                </button>
                <div className="key-group">
                  {KEY_GROUPS[keyGroup].map((k) => (
                    <button
                      key={k.aria}
                      className={`key-button ${
                        k.toggle && ctrlMode !== "off" ? `armed ${ctrlMode}` : ""
                      }`}
                      aria-label={k.aria}
                      aria-pressed={k.toggle ? ctrlMode !== "off" : undefined}
                      // Keep focus on the terminal so the mobile keyboard stays up.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() =>
                        k.toggle
                          ? client.cycleCtrl()
                          : client.input(activeSessionId, k.seq!)
                      }
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
