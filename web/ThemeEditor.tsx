import { useMemo, useState } from "react";
import {
  DRAFT_KEY,
  THEME_VARS,
  applyTheme,
  defaultTheme,
  deleteTheme,
  isColor,
  listThemes,
  normalizeHex,
  pxValue,
  readTheme,
  resetTheme,
  saveTheme,
  serializeTheme,
  type SavedThemes,
  type Theme,
} from "./theme";

export default function ThemeEditor() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [saved, setSaved] = useState<SavedThemes>(() => listThemes());
  const [name, setName] = useState("");

  const css = useMemo(() => serializeTheme(theme), [theme]);
  const base = useMemo(() => defaultTheme(), []);

  const set = (name: string, value: string) => {
    const next = { ...theme, [name]: normalizeHex(value) };
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    } catch {
      /* storage full/blocked — editing still works, just isn't durable */
    }
  };

  const reset = () => {
    resetTheme();
    localStorage.removeItem(DRAFT_KEY);
    setTheme(readTheme());
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(css);
    } catch {
      return; // insecure context / denied — the <pre> below is selectable
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Applying a stored palette goes through the same path as editing, so the
  // draft stays in step with what's on screen.
  const applyNamed = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    } catch {
      /* non-durable, same as an edit */
    }
  };

  const commitSave = () => {
    const key = name.trim();
    if (!key) return;
    setSaved(saveTheme(key, theme));
    setName("");
  };

  const savedNames = Object.keys(saved).sort();

  const groups = THEME_VARS.reduce<Record<string, typeof THEME_VARS>>((acc, v) => {
    (acc[v.group] ||= []).push(v);
    return acc;
  }, {});

  return (
    <div className={`theme-editor${collapsed ? " collapsed" : ""}`}>
      <div className="theme-editor-head">
        <strong>Theme</strong>
        <div className="theme-editor-head-actions">
          <button onClick={reset} title="Back to the values in styles.css">
            Reset
          </button>
          <button onClick={copy} className="theme-copy">
            {copied ? "Copied" : "Copy CSS"}
          </button>
          <button onClick={() => setCollapsed((c) => !c)} title="Collapse">
            {collapsed ? "▲" : "▼"}
          </button>
          <button onClick={() => (location.hash = "")} title="Close">
            ✕
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="theme-editor-body">
          {Object.entries(groups).map(([group, vars]) => (
            <div key={group} className="theme-group">
              <div className="theme-group-name">{group}</div>
              {vars.map((v) => (
                <label key={v.name} className="theme-row">
                  {isColor(v) ? (
                    <input
                      type="color"
                      value={theme[v.name] ?? "#000000"}
                      onChange={(e) => set(v.name, e.target.value)}
                    />
                  ) : (
                    <span className="theme-swatch-px">{pxValue(theme[v.name])}</span>
                  )}
                  <span className="theme-row-label">
                    {v.label}
                    {v.hint && <em>{v.hint}</em>}
                  </span>
                  {isColor(v) ? (
                    <input
                      type="text"
                      className="theme-hex"
                      value={theme[v.name] ?? ""}
                      spellCheck={false}
                      onChange={(e) => set(v.name, e.target.value)}
                    />
                  ) : (
                    <input
                      type="range"
                      className="theme-range"
                      min={0}
                      max={v.max ?? 20}
                      step={1}
                      value={pxValue(theme[v.name])}
                      onChange={(e) => set(v.name, `${e.target.value}px`)}
                    />
                  )}
                  {theme[v.name] !== base[v.name] && (
                    <button
                      className="theme-revert"
                      title={`Revert to ${base[v.name]}`}
                      onClick={(e) => {
                        e.preventDefault();
                        set(v.name, base[v.name]);
                      }}
                    >
                      ↺
                    </button>
                  )}
                </label>
              ))}
            </div>
          ))}

          <div className="theme-group">
            <div className="theme-group-name">Saved</div>
            <div className="theme-save-row">
              <input
                type="text"
                className="theme-name"
                placeholder="Palette name"
                value={name}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commitSave()}
              />
              <button onClick={commitSave} disabled={!name.trim()}>
                {savedNames.includes(name.trim()) ? "Overwrite" : "Save"}
              </button>
            </div>
            {savedNames.length === 0 ? (
              <div className="theme-empty">Nothing saved yet.</div>
            ) : (
              savedNames.map((n) => (
                <div key={n} className="theme-saved-row">
                  <button
                    className="theme-saved-load"
                    onClick={() => applyNamed(saved[n])}
                    title="Load this palette"
                  >
                    <span className="theme-saved-name">{n}</span>
                    <span className="theme-saved-chips">
                      {["bg", "panel", "raised", "accent"].map((k) => (
                        <i key={k} style={{ background: saved[n][k] }} />
                      ))}
                    </span>
                  </button>
                  <button
                    className="theme-revert"
                    title={`Delete "${n}"`}
                    onClick={() => setSaved(deleteTheme(n))}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          <pre className="theme-css">{css}</pre>
        </div>
      )}
    </div>
  );
}
