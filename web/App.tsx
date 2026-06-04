import { useEffect, useMemo, useRef, useState } from "react";
import type { HarnessInfo, SessionInfo } from "../shared/protocol";
import { Client } from "./client";
import { TerminalView } from "./TerminalView";

export function App() {
  const client = useMemo(() => new Client(), []);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const knownIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    client.connect();
    fetch("/api/harnesses")
      .then((r) => r.json())
      .then(setHarnesses)
      .catch(() => setHarnesses([]));
    return client.onSessions(setSessions);
  }, [client]);

  // Auto-select newly created sessions (and the first one we ever see).
  useEffect(() => {
    let next: string | null = null;
    for (const s of sessions) {
      if (!knownIds.current.has(s.id)) {
        knownIds.current.add(s.id);
        next = s.id;
      }
    }
    if (next) setActiveId(next);
    else if (activeId === null && sessions.length > 0) setActiveId(sessions[0].id);
  }, [sessions, activeId]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>agent-remote</h1>

        <section>
          <label className="field-label">Working directory</label>
          <input
            className="cwd-input"
            placeholder="(server default)"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
          <div className="launch-buttons">
            {harnesses.map((h) => (
              <button
                key={h.id}
                className="launch-button"
                onClick={() => client.start(h.id, cwd.trim() || undefined)}
              >
                + {h.name}
              </button>
            ))}
            {harnesses.length === 0 && (
              <p className="muted">No harnesses enabled in config.json.</p>
            )}
          </div>
        </section>

        <section className="session-list">
          <label className="field-label">Sessions</label>
          {sessions.length === 0 && <p className="muted">No sessions yet.</p>}
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`session-item ${s.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(s.id)}
            >
              <span className={`status-dot ${s.status}`} />
              <span className="session-name">{s.harnessName}</span>
              <span className="session-meta">
                {s.status === "exited" ? `exited (${s.exitCode ?? "?"})` : "running"}
              </span>
            </button>
          ))}
        </section>
      </aside>

      <main className="main">
        {sessions.length === 0 ? (
          <div className="empty-state">
            Launch a session from the sidebar to get started.
          </div>
        ) : (
          sessions.map((s) => (
            <TerminalView
              key={s.id}
              client={client}
              sessionId={s.id}
              active={s.id === activeId}
            />
          ))
        )}
      </main>
    </div>
  );
}
