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
import { mediaKindFor, type MediaKind } from "../shared/media";

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

// Swipe-to-navigate zone inside the media preview, as a fraction of its box:
// top-left only, so the gesture never fights the native video control strip
// (bottom) or the close button (top-right). Resize here.
const SWIPE_ZONE = { width: 0.5, height: 0.75 };
// Under this a drag is a tap — we never claim it, so tap-to-pause still works.
const SWIPE_MIN_PX = 40;

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
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
  // Destination for uploads ("" = folder root), named in the Upload button so
  // it's never ambiguous where a file will land.
  const [selectedDir, setSelectedDir] = useState("");
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- editor state ---------------------------------------------------------
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // --- media preview --------------------------------------------------------
  // Invariant: only ever open while doc === null, so the left pane is always the
  // picker (opening or creating a text file closes it).
  const [preview, setPreview] = useState<{ path: string; kind: MediaKind } | null>(
    null,
  );
  const [previewError, setPreviewError] = useState(false);
  // The swipe gesture is invisible, so the position counter is the only thing
  // announcing a gallery exists. Shown on open/step, then faded.
  const [counterShown, setCounterShown] = useState(false);

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
    const shown = doc?.path ?? preview?.path ?? null;
    onOpenFileChange?.(shown ? baseName(shown) : null);
  }, [doc, preview, onOpenFileChange]);

  const toggleDir = (path: string) => {
    setSelectedDir(path);
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

  const downloadUrl = (path: string) =>
    `/api/download?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;

  const mediaUrl = (path: string) =>
    `/api/media?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;

  // Gallery neighbours = previewable files in the same directory, in tree order.
  // The listing is already client-side, so stepping needs no extra request.
  const siblings = preview
    ? (dirs[dirOf(preview.path)] ?? [])
        .filter((e) => e.type === "file" && mediaKindFor(e.path))
        .map((e) => e.path)
    : [];
  const previewIndex = preview ? siblings.indexOf(preview.path) : -1;

  // Clamped, not wrapping: hitting the end should be felt, not loop silently.
  const stepPreview = (delta: number) => {
    if (previewIndex < 0) return;
    const next = siblings[previewIndex + delta];
    const kind = next ? mediaKindFor(next) : null;
    if (!next || !kind) return;
    setPreviewError(false);
    setPreview({ path: next, kind });
  };

  // Handlers live on the preview wrapper rather than an overlay element: an
  // overlay would swallow taps meant for the media's own controls.
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const onPreviewTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t || e.touches.length > 1) {
      swipeStart.current = null;
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const inZone =
      t.clientX - r.left < r.width * SWIPE_ZONE.width &&
      t.clientY - r.top < r.height * SWIPE_ZONE.height;
    swipeStart.current = inZone ? { x: t.clientX, y: t.clientY } : null;
  };

  const onPreviewTouchEnd = (e: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // Horizontal intent only, so a vertical drag stays the browser's.
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return;
    stepPreview(dx < 0 ? 1 : -1);
  };

  // Upload into `selectedDir`, one request per file. A 409 means the name is
  // taken — confirm before retrying with overwrite, since the tree gives no
  // other warning.
  const uploadFiles = async (files: File[]) => {
    if (!files.length || uploading) return;
    setUploading(true);
    setPickerError(null);
    let done = 0;
    try {
      for (const file of files) {
        const rel = joinPath(selectedDir, file.name);
        setUploadStatus(
          files.length > 1
            ? `Uploading ${done + 1}/${files.length}: ${file.name}…`
            : `Uploading ${file.name}…`,
        );
        const post = (overwrite: boolean) =>
          fetch(
            `/api/file-upload?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(rel)}` +
              (overwrite ? "&overwrite=1" : ""),
            { method: "POST", body: file },
          );
        let r = await post(false);
        if (r.status === 409) {
          if (!window.confirm(`${rel} already exists. Overwrite it?`)) continue;
          r = await post(true);
        }
        if (!r.ok) {
          const msg = await r.json().catch(() => ({ message: "Upload failed." }));
          throw new Error(`${file.name}: ${msg.message ?? "Upload failed."}`);
        }
        done++;
      }
      setUploadStatus(done ? `Uploaded ${done} file${done === 1 ? "" : "s"}` : null);
      setTimeout(() => setUploadStatus(null), 2000);
    } catch (e) {
      setPickerError((e as Error).message);
      setUploadStatus(null);
    } finally {
      setUploading(false);
      // Reveal what just landed.
      setExpanded((prev) => new Set(prev).add(selectedDir));
      loadDir(selectedDir);
    }
  };

  const openFile = (path: string) => {
    // Media never round-trips through /api/file (which would read the whole file
    // just to refuse it as binary); clicking another one swaps the preview.
    const kind = mediaKindFor(path);
    if (kind) {
      setPreviewError(false);
      setPreview({ path, kind });
      setStatus(null);
      return;
    }
    setPreview(null);
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
    setPreview(null);
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

  // Cmd/Ctrl+S saves from within the editor; Escape dismisses a preview.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (doc && dirty && !saving) save();
      }
      if (e.key === "Escape" && preview) setPreview(null);
      if (preview && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        stepPreview(e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, doc, dirty, saving, preview]);

  useEffect(() => {
    if (!preview || siblings.length < 2) return;
    setCounterShown(true);
    const t = setTimeout(() => setCounterShown(false), 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.path, siblings.length]);

  const renderTree = (path: string, depth: number) => {
    const entries = dirs[path];
    if (!entries) return null;
    return entries.map((entry) => {
      const isOpen = expanded.has(entry.path);
      const isDir = entry.type === "dir";
      return (
        <div key={entry.path}>
          <div
            className={`file-row-wrap${
              isDir && entry.path === selectedDir ? " selected" : ""
            }`}
          >
            <button
              className="file-row"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => (isDir ? toggleDir(entry.path) : openFile(entry.path))}
              title={entry.path}
            >
              <span className="file-row-icon">
                {isDir ? (isOpen ? "▾" : "▸") : "·"}
              </span>
              <span className="file-row-name">{entry.name}</span>
            </button>
            {!isDir && (
              <a
                className="file-row-download"
                href={downloadUrl(entry.path)}
                download={entry.name}
                title={`Download ${entry.name}`}
                aria-label={`Download ${entry.name}`}
              >
                ↓
              </a>
            )}
          </div>
          {isDir && isOpen && renderTree(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      className="editor-panel"
      style={{ display: active ? "flex" : "none" }}
    >
      <div className="editor-main">
        {doc === null ? (
          <>
            <div className="editor-picker-head">
              <span className="editor-picker-title">Open a file</span>
              {newFileName === null ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => {
                      void uploadFiles(Array.from(e.target.files ?? []));
                      e.target.value = "";
                    }}
                  />
                  <button
                    className="editor-new-button"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    title={`Upload into ${selectedDir || baseName(cwd) || "the folder root"}`}
                  >
                    {uploading ? "Uploading…" : `Upload to ${selectedDir || "/"}`}
                  </button>
                  <button
                    className="editor-new-button"
                    onClick={() => setNewFileName("")}
                  >
                    New file
                  </button>
                </>
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
            {uploadStatus && <div className="editor-status-line">{uploadStatus}</div>}
            {status && !loading && <div className="editor-error">{status}</div>}
            <div
              className={`file-tree${dragging ? " dragover" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void uploadFiles(Array.from(e.dataTransfer.files));
              }}
            >
              {renderTree("", 0)}
            </div>
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
              {!doc.isNew && (
                <a
                  className="file-row-download editor-download"
                  href={downloadUrl(doc.path)}
                  download={baseName(doc.path)}
                  title={`Download ${baseName(doc.path)}`}
                  aria-label={`Download ${baseName(doc.path)}`}
                >
                  ↓
                </a>
              )}
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
      {preview && (
        <div
          className="editor-preview"
          role="dialog"
          aria-modal="true"
          aria-label={baseName(preview.path)}
          // Backdrop dismiss: the scrim on mobile, the gutter around the media
          // on desktop.
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreview(null);
          }}
          onTouchStart={onPreviewTouchStart}
          onTouchEnd={onPreviewTouchEnd}
        >
          {previewError ? (
            <div className="editor-preview-error">
              Could not display {baseName(preview.path)}.
              <a
                className="file-row-download"
                href={downloadUrl(preview.path)}
                download={baseName(preview.path)}
                title={`Download ${baseName(preview.path)}`}
              >
                ↓
              </a>
            </div>
          ) : preview.kind === "image" ? (
            // Remount on path change: swapping a live <video src> without
            // .load() can leave the previous media loaded.
            <img
              key={preview.path}
              className="editor-preview-media"
              src={mediaUrl(preview.path)}
              alt={baseName(preview.path)}
              onError={() => setPreviewError(true)}
            />
          ) : (
            <video
              key={preview.path}
              className="editor-preview-media"
              src={mediaUrl(preview.path)}
              controls
              loop
              playsInline
              preload="metadata"
              onError={() => setPreviewError(true)}
            />
          )}
          {previewIndex >= 0 && siblings.length > 1 && (
            <div
              className={`editor-preview-counter${counterShown ? " shown" : ""}`}
              aria-hidden="true"
            >
              {previewIndex + 1} / {siblings.length}
            </div>
          )}
          <button
            className="editor-preview-close"
            onClick={() => setPreview(null)}
            aria-label="Close preview"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
