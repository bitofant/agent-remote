import { useState } from "react";
import { login, register } from "./auth";

type Mode = "login" | "register";

// Login / register gate shown until the browser holds a valid session.
export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setMessage(null);
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        const res = await login(username.trim(), password);
        if (res.ok) onAuthed();
        else setError(res.message ?? "Login failed.");
      } else {
        const res = await register(username.trim(), password);
        if (res.ok) {
          setMessage(res.message ?? "Registered.");
          setMode("login");
          setPassword("");
        } else {
          setError(res.message ?? "Registration failed.");
        }
      }
    } catch {
      setError("Network error. Is the server running?");
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setMessage(null);
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>agent-remote</h1>
        <div className="login-tabs">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => switchMode("login")}
          >
            Log in
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => switchMode("register")}
          >
            Register
          </button>
        </div>

        <label className="field-label">Username</label>
        <input
          className="login-input"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />

        <label className="field-label">Password</label>
        <input
          className="login-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />

        {error && <p className="login-error">{error}</p>}
        {message && <p className="login-message">{message}</p>}

        <button
          className="login-submit"
          type="submit"
          disabled={busy || !username.trim() || !password}
        >
          {mode === "login" ? "Log in" : "Register"}
        </button>
      </form>
    </div>
  );
}
