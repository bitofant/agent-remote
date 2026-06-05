import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FolderInfo,
  HarnessInfo,
  SessionInfo,
} from "../shared/protocol";
import { Client } from "./client";
import { TerminalView } from "./TerminalView";

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function App() {
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
    return () => {
      offSessions();
      offFolders();
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

  const sessionsInFolder = sessions.filter((s) => s.cwd === activeFolder);
  const activeSessionId =
    activeFolder !== null
      ? (activeSession[activeFolder] ??
        sessionsInFolder[sessionsInFolder.length - 1]?.id ??
        null)
      : null;

  return (
    <div className="app">
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
        <h1>agent-remote</h1>

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
                />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
