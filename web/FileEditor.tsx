import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { php } from "@codemirror/lang-php";
import { java } from "@codemirror/lang-java";
import type { DirListing, FileContent, FileEntry } from "../shared/protocol";

// Map a filename to a CodeMirror language extension for syntax highlighting.
// Unknown extensions get no language (plain text) rather than a wrong one.
function languageFor(path: string): Extension | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript();
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "json":
      return json();
    case "html":
    case "htm":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "py":
      return python();
    case "md":
    case "markdown":
      return markdown();
    case "yml":
    case "yaml":
      return yaml();
    case "rs":
      return rust();
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "hpp":
      return cpp();
    case "xml":
    case "svg":
      return xml();
    case "sql":
      return sql();
    case "php":
      return php();
    case "java":
      return java();
    default:
      return null;
  }
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ message: "Request failed." }));
    throw new Error(msg.message ?? "Request failed.");
  }
  return r.json();
}

// The file being edited. `content` is the on-disk baseline used to detect dirty
// state; `isNew` means it hasn't been written yet (created via "New file").
interface OpenDoc {
  path: string;
  content: string;
  isNew: boolean;
}

// File-editor tab: folder-tree picker → CodeMirror editor, confined to `cwd`
// via /api/files + /api/file. Kept mounted (hidden when inactive) so unsaved
// edits survive tab switches.
export function FileEditor({
  cwd,
  active,
  onOpenFileChange,
}: {
  cwd: string;
  active: boolean;
  // Reports the currently open file (base name) or null, so the session list
  // can show it as the tab's subtitle.
  onOpenFileChange?: (name: string | null) => void;
}) {
  // --- picker state (persists across the picker⇄editor toggle) --------------
  // Loaded directory listings, keyed by path relative to the root ("" = root).
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState<string | null>(null);

  // --- editor state ---------------------------------------------------------
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const loadDir = useCallback(
    (path: string) => {
      fetchJson<DirListing>(
        `/api/files?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
      )
        .then((listing) => {
          setDirs((prev) => ({ ...prev, [path]: listing.entries }));
          setPickerError(null);
        })
        .catch((e: Error) => setPickerError(e.message));
    },
    [cwd],
  );

  // Load the root listing once.
  useEffect(() => {
    loadDir("");
  }, [loadDir]);

  useEffect(() => {
    onOpenFileChange?.(doc ? baseName(doc.path) : null);
  }, [doc, onOpenFileChange]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!dirs[path]) loadDir(path);
      }
      return next;
    });
  };

  const openFile = (path: string) => {
    setLoading(true);
    setStatus(null);
    fetchJson<FileContent>(
      `/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
    )
      .then((file) => {
        setDoc({ path: file.path, content: file.content, isNew: false });
        setDirty(false);
      })
      .catch((e: Error) => setStatus(e.message))
      .finally(() => setLoading(false));
  };

  const createNewFile = () => {
    const name = (newFileName ?? "").trim();
    if (!name) return;
    setNewFileName(null);
    setDoc({ path: name, content: "", isNew: true });
    setDirty(true);
    setStatus(null);
  };

  const closeFile = () => {
    setDoc(null);
    setDirty(false);
    setStatus(null);
    // Refresh the root to surface any newly-saved file (common case).
    loadDir("");
  };

  const save = () => {
    if (!doc || !viewRef.current) return;
    const content = viewRef.current.state.doc.toString();
    setSaving(true);
    setStatus(null);
    fetch(
      `/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(doc.path)}`,
      {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: content,
      },
    )
      .then(async (r) => {
        if (!r.ok) {
          const msg = await r.json().catch(() => ({ message: "Save failed." }));
          throw new Error(msg.message ?? "Save failed.");
        }
        setDoc((d) => (d ? { ...d, content, isNew: false } : d));
        setDirty(false);
        setStatus("Saved");
        setTimeout(() => setStatus((s) => (s === "Saved" ? null : s)), 1500);
      })
      .catch((e: Error) => setStatus(e.message))
      .finally(() => setSaving(false));
  };

  // Build (and rebuild on file change) the CodeMirror instance for the open doc.
  useEffect(() => {
    if (!doc || !editorHostRef.current) return;
    const lang = languageFor(doc.path);
    const view = new EditorView({
      parent: editorHostRef.current,
      state: EditorState.create({
        doc: doc.content,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          oneDark,
          EditorView.lineWrapping,
          ...(lang ? [lang] : []),
          EditorView.updateListener.of((u) => {
            // Compare against the on-disk baseline so undo-to-baseline clears dirty.
            if (u.docChanged) setDirty(u.state.doc.toString() !== doc.content);
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Recreate only when the identity/baseline of the open doc changes, not on
    // every keystroke (dirty is tracked via the update listener instead).
  }, [doc?.path, doc?.content, doc?.isNew]);

  // Cmd/Ctrl+S saves from within the editor.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (doc && dirty && !saving) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, doc, dirty, saving]);

  const renderTree = (path: string, depth: number) => {
    const entries = dirs[path];
    if (!entries) return null;
    return entries.map((entry) => {
      const isOpen = expanded.has(entry.path);
      return (
        <div key={entry.path}>
          <button
            className="file-row"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() =>
              entry.type === "dir" ? toggleDir(entry.path) : openFile(entry.path)
            }
            title={entry.path}
          >
            <span className="file-row-icon">
              {entry.type === "dir" ? (isOpen ? "▾" : "▸") : "·"}
            </span>
            <span className="file-row-name">{entry.name}</span>
          </button>
          {entry.type === "dir" && isOpen && renderTree(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      className="editor-panel"
      style={{ display: active ? "flex" : "none" }}
    >
      {doc === null ? (
        <>
          <div className="editor-picker-head">
            <span className="editor-picker-title">Open a file</span>
            {newFileName === null ? (
              <button
                className="editor-new-button"
                onClick={() => setNewFileName("")}
              >
                New file
              </button>
            ) : (
              <div className="editor-new-form">
                <input
                  className="editor-new-input"
                  autoFocus
                  placeholder="path/to/new-file.ts"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createNewFile();
                    if (e.key === "Escape") setNewFileName(null);
                  }}
                />
                <button className="editor-new-button" onClick={createNewFile}>
                  Create
                </button>
              </div>
            )}
          </div>
          {pickerError && <div className="editor-error">{pickerError}</div>}
          {loading && <div className="editor-status-line">Opening…</div>}
          {status && !loading && <div className="editor-error">{status}</div>}
          <div className="file-tree">{renderTree("", 0)}</div>
        </>
      ) : (
        <>
          <div className="editor-head">
            <button
              className="editor-back"
              onClick={closeFile}
              aria-label="Back to files"
            >
              ‹
            </button>
            <span className="editor-file-path" title={doc.path}>
              {doc.path}
              {dirty ? " •" : ""}
            </span>
            {status && <span className="editor-save-status">{status}</span>}
            <button
              className="editor-save-button"
              onClick={save}
              disabled={!dirty || saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <div className="editor-host" ref={editorHostRef} />
        </>
      )}
    </div>
  );
}
