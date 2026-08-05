import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowseListing } from "../shared/protocol";
import {
  chainFrom,
  matchEntries,
  rootFor,
  splitTyped,
  toAbsDir,
  toTyped,
} from "./folderPath";

interface Entry {
  name: string;
  path: string;
}
interface Listing {
  entries?: Entry[];
  error?: string;
  truncated?: boolean;
}

// Modal folder browser for adding a folder. The text field is the source of
// truth: the tree is a *view* of what's typed (ancestors auto-expanded, the
// best prefix match highlighted), and every tree interaction writes back into
// the field — so typing, tabbing and tapping all end at the same string.
export function FolderPicker({
  home,
  onAdd,
  onClose,
}: {
  home: string;
  onAdd: (path: string) => void;
  onClose: () => void;
}) {
  // `~/` only means something once the server's $HOME has arrived.
  const [text, setText] = useState(() => (home ? "~/" : "/"));
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Index into the prefix-matching siblings — the "targeted" completion.
  const [highlight, setHighlight] = useState(0);
  const inFlight = useRef<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRow = useRef<HTMLDivElement>(null);

  // A lone `~` is home, not a partial name being typed under it.
  const { dir, partial } = splitTyped(text.trim() === "~" ? "~/" : text);
  const absDir = toAbsDir(dir, home);
  const root = rootFor(absDir, home);
  // Keep the user's own notation when we rewrite the field.
  const asTyped = (path: string) =>
    dir === "" || dir.startsWith("~") ? toTyped(path, home) : path;

  const load = useCallback((path: string) => {
    if (inFlight.current.has(path)) return;
    inFlight.current.add(path);
    fetch(`/api/browse?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((l: BrowseListing & { message?: string }) =>
        setListings((prev) => ({
          ...prev,
          [path]: l.entries
            ? { entries: l.entries, truncated: l.truncated }
            : { error: l.message || "Not readable." },
        })),
      )
      .catch(() => setListings((prev) => ({ ...prev, [path]: { error: "Not readable." } })));
  }, []);

  // The typed path drives the tree: load + expand root → typed directory.
  const chain = useMemo(() => chainFrom(root, absDir), [root, absDir]);
  useEffect(() => {
    for (const p of chain) if (!listings[p]) load(p);
    setExpanded((prev) => {
      if (chain.every((p) => prev.has(p))) return prev;
      return new Set([...prev, ...chain]);
    });
  }, [chain, listings, load]);

  const siblings = listings[absDir]?.entries ?? [];
  const candidates = useMemo(
    () => matchEntries(siblings, partial),
    [siblings, partial],
  );
  const selected = candidates[Math.min(highlight, candidates.length - 1)] ?? null;
  useEffect(() => setHighlight(0), [absDir, partial]);
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest" });
  }, [selected?.path]);
  useEffect(() => inputRef.current?.focus(), []);

  // We only know a folder is missing once its parent is listed; until then stay
  // optimistic rather than blocking Add on a request in flight.
  const dirListing = listings[absDir];
  const missing = partial
    ? !!dirListing?.entries && !siblings.some((e) => e.name === partial)
    : !!dirListing?.error;
  const canAdd = !!text.trim() && !missing;

  const complete = (entry: Entry) => {
    setText(asTyped(entry.path));
    inputRef.current?.focus();
  };
  const submit = () => {
    if (canAdd) onAdd(text.trim());
    else if (selected) complete(selected); // typed a partial: finish it instead
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "Enter") return submit();
    if (e.key === "Tab") {
      if (!selected) return;
      e.preventDefault();
      complete(selected);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const n = candidates.length;
    if (n === 0) return;
    const step = e.key === "ArrowDown" ? 1 : -1;
    // Clamp first: `highlight` can outrun a shrunken candidate list.
    setHighlight((h) => (Math.min(h, n - 1) + step + n) % n);
  };

  const toggle = (path: string) => {
    if (!listings[path]) load(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // A plain recursive function, not a nested component: a component defined
  // during render is a fresh type each keystroke and would remount (and scroll-
  // reset) the whole tree.
  const rows = (path: string, depth: number) => {
    const listing = listings[path];
    if (!listing) return <div className="picker-note" style={indent(depth)}>Loading…</div>;
    if (listing.error)
      return (
        <div className="picker-note" style={indent(depth)}>
          {listing.error}
        </div>
      );
    if (listing.entries!.length === 0)
      return <div className="picker-note" style={indent(depth)}>No subfolders</div>;
    return (
      <>
        {listing.entries!.map((entry) => {
          const open = expanded.has(entry.path);
          const isSelected = selected?.path === entry.path;
          return (
            <div key={entry.path}>
              <div
                className={`picker-row ${isSelected ? "selected" : ""} ${
                  entry.path === absDir ? "current" : ""
                }`}
                ref={isSelected ? selectedRow : undefined}
              >
                <button
                  className="picker-caret"
                  style={indent(depth)}
                  aria-label={open ? "Collapse" : "Expand"}
                  onClick={() => toggle(entry.path)}
                >
                  {open ? "▾" : "▸"}
                </button>
                <button
                  className="picker-name"
                  onClick={() => complete(entry)}
                  title={entry.path}
                >
                  {entry.name}
                </button>
              </div>
              {open && rows(entry.path, depth + 1)}
            </div>
          );
        })}
        {listing.truncated && (
          <div className="picker-note" style={indent(depth)}>
            Too many subfolders — type to narrow.
          </div>
        )}
      </>
    );
  };

  return (
    <div className="resume-overlay" onClick={onClose}>
      <div
        className="resume-dialog folder-picker"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="resume-dialog-head">
          <span>Add folder</span>
          <button className="resume-dialog-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="picker-input-row">
          <input
            ref={inputRef}
            className="cwd-input"
            placeholder="~/path/to/folder"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="picker-add" disabled={!canAdd} onClick={submit}>
            Add
          </button>
        </div>
        <div className="resume-dialog-body picker-tree">
          <div className={`picker-row ${absDir === root ? "current" : ""}`}>
            <button className="picker-name" onClick={() => setText(asTyped(root))}>
              {toTyped(root, home)}
            </button>
          </div>
          {rows(root, 1)}
        </div>
        {missing && <div className="picker-status">No such folder.</div>}
      </div>
    </div>
  );
}

const indent = (depth: number) => ({ paddingLeft: `${4 + depth * 14}px` });
