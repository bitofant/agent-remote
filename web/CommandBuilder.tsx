import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandListing, CommandResolveResult } from "../shared/protocol";
import type { Client } from "./client";
import { COMMAND_CATALOG, COMMON_COMMANDS, type ArgNode } from "./commandCatalog";

// The current argument-suggestion level: static catalog nodes plus an optional
// server-side resolver whose live results are shown alongside them.
interface ArgLevel {
  nodes: ArgNode[];
  source?: string;
}

// One selectable row in the command-picker step.
interface CommandOption {
  name: string; // shown + matched
  insert: string; // token written to the terminal (e.g. "./build.sh")
  detail?: string; // alias expansion or catalog description
  whole?: boolean; // a full command line (history) — insert as-is, no arg step
}

interface Section {
  title: string;
  options: CommandOption[];
}

const prefix = (s: string, q: string) =>
  s.toLowerCase().startsWith(q.toLowerCase());

// Modal that builds a command line from the cwd's executables, $PATH, aliases
// and a static catalog of well-known subcommands/flags, then inserts it into the
// terminal (without pressing Enter — the user reviews and runs it).
export function CommandBuilder({
  client,
  sessionId,
  cwd,
  onClose,
}: {
  client: Client;
  sessionId: string;
  cwd: string;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<CommandListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // null = still picking a command; set = building its arguments.
  const [chosen, setChosen] = useState<CommandOption | null>(null);
  const [tokens, setTokens] = useState<string[]>([]);
  const [level, setLevel] = useState<ArgLevel>({ nodes: [] });
  // Live suggestions resolved from `level.source` (e.g. container names).
  const [dynamic, setDynamic] = useState<ArgNode[]>([]);
  const [dynLoading, setDynLoading] = useState(false);
  const [dynError, setDynError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/commands?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
      .then((l: CommandListing) => setListing(l))
      .catch(() => setError("Couldn't load commands."));
  }, [cwd]);

  // Refocus the search box whenever the step changes, so typing keeps filtering.
  useEffect(() => {
    inputRef.current?.focus();
  }, [chosen]);

  // Esc closes the dialog from anywhere within it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // --- command-picker step: sections, local → aliases → common → all PATH ----
  const sections = useMemo<Section[]>(() => {
    if (!listing) return [];
    const common = new Set(COMMON_COMMANDS);
    // Recent/Frequent rows are whole command lines (possibly with args), so they
    // insert directly rather than entering the argument-builder.
    const wholeLine = (line: string): CommandOption => ({
      name: line,
      insert: line,
      whole: true,
    });
    const out: Section[] = [
      {
        title: "Recent",
        options: listing.recent.map(wholeLine),
      },
      {
        title: "Frequent",
        options: listing.frequent.map(wholeLine),
      },
      {
        title: "This folder",
        options: listing.local.map((n) => ({ name: `./${n}`, insert: `./${n}` })),
      },
      {
        title: "Aliases",
        options: listing.aliases.map((a) => ({
          name: a.name,
          insert: a.name,
          detail: a.value,
        })),
      },
      {
        title: "Common",
        options: COMMON_COMMANDS.map((n) => ({
          name: n,
          insert: n,
          detail: COMMAND_CATALOG[n]?.detail,
        })),
      },
      {
        title: "All commands",
        // Drop ones already in Common to avoid showing them twice.
        options: listing.path
          .filter((n) => !common.has(n))
          .map((n) => ({ name: n, insert: n })),
      },
    ];
    return out
      .map((s) => ({ ...s, options: s.options.filter((o) => prefix(o.name, query)) }))
      .filter((s) => s.options.length > 0);
  }, [listing, query]);

  const firstOption = sections[0]?.options[0];

  const pickCommand = (opt: CommandOption) => {
    // History entries are complete command lines — insert them directly,
    // skipping the argument-builder step (there's nothing left to build).
    if (opt.whole) {
      client.input(sessionId, opt.insert); // insert only — no trailing newline
      onClose();
      return;
    }
    setChosen(opt);
    setTokens([]);
    setQuery("");
    setLevel({ nodes: COMMAND_CATALOG[opt.name]?.args ?? [] });
  };

  // --- argument step ---------------------------------------------------------
  // Fetch live suggestions whenever we descend into a level with a resolver.
  useEffect(() => {
    setDynamic([]);
    setDynError(null);
    if (!level.source) {
      setDynLoading(false);
      return;
    }
    setDynLoading(true);
    let cancelled = false;
    fetch(
      `/api/resolve?id=${encodeURIComponent(level.source)}&cwd=${encodeURIComponent(cwd)}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: CommandResolveResult) => {
        if (cancelled) return;
        setDynamic(d.suggestions.map((s) => ({ value: s.value, detail: s.detail })));
        setDynError(d.error ?? null);
      })
      .catch(() => {
        if (!cancelled) setDynError("Couldn't load suggestions.");
      })
      .finally(() => {
        if (!cancelled) setDynLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [level, cwd]);

  // Live (resolved) suggestions first, then the static catalog ones.
  const argMatches = useMemo(
    () => [...dynamic, ...level.nodes].filter((a) => prefix(a.value, query)),
    [dynamic, level, query],
  );

  const addArg = (node: ArgNode) => {
    setTokens((t) => [...t, node.value]);
    setQuery("");
    // Descend when this token has its own suggestions (static or resolved);
    // otherwise keep the current level so further flags can be added.
    if (node.children || node.source) {
      setLevel({ nodes: node.children ?? [], source: node.source });
    }
  };

  const addRawArg = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    setTokens((t) => [...t, v]);
    setQuery("");
  };

  const removeLastToken = () => setTokens((t) => t.slice(0, -1));

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!chosen) {
      if (firstOption) pickCommand(firstOption);
      return;
    }
    // Prefer a matching suggestion; fall back to the raw typed token.
    if (argMatches.length > 0) addArg(argMatches[0]);
    else addRawArg(query);
  };

  const finalCommand = chosen
    ? [chosen.insert, ...tokens, query.trim()].filter(Boolean).join(" ")
    : "";

  const insert = () => {
    if (!finalCommand) return;
    client.input(sessionId, finalCommand); // insert only — no trailing newline
    onClose();
  };

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="cmd-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmd-head">
          {chosen ? (
            <button
              className="cmd-back"
              onClick={() => {
                setChosen(null);
                setQuery("");
              }}
              aria-label="Back to commands"
            >
              ‹
            </button>
          ) : (
            <span className="cmd-title">./ command</span>
          )}
          {chosen && (
            <div className="cmd-preview">
              <code>{finalCommand || chosen.insert}</code>
              {tokens.length > 0 && (
                <button
                  className="cmd-pop"
                  onClick={removeLastToken}
                  aria-label="Remove last argument"
                >
                  ⌫
                </button>
              )}
            </div>
          )}
          <button className="cmd-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <input
          ref={inputRef}
          className="cmd-search"
          placeholder={chosen ? "Add argument…" : "Filter commands…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          autoFocus
        />

        <div className="cmd-list">
          {error && <div className="cmd-empty">{error}</div>}
          {!error && !listing && <div className="cmd-empty">Loading…</div>}

          {!chosen &&
            sections.map((s) => (
              <div key={s.title} className="cmd-section">
                <div className="cmd-section-title">{s.title}</div>
                {s.options.map((o) => (
                  <button
                    key={`${s.title}:${o.name}`}
                    className="cmd-option"
                    onClick={() => pickCommand(o)}
                  >
                    <span className="cmd-option-name">{o.name}</span>
                    {o.detail && <span className="cmd-option-detail">{o.detail}</span>}
                  </button>
                ))}
              </div>
            ))}

          {chosen && (
            <div className="cmd-section">
              {dynLoading && <div className="cmd-empty">Loading suggestions…</div>}
              {dynError && <div className="cmd-empty">{dynError}</div>}
              {argMatches.map((a, i) => (
                <button
                  key={`${a.value}-${i}`}
                  className="cmd-option"
                  onClick={() => addArg(a)}
                >
                  <span className="cmd-option-name">{a.value}</span>
                  {a.detail && <span className="cmd-option-detail">{a.detail}</span>}
                  {(a.children || a.source) && (
                    <span className="cmd-option-more">›</span>
                  )}
                </button>
              ))}
              {!dynLoading && argMatches.length === 0 && (
                <div className="cmd-empty">
                  {level.nodes.length === 0 && dynamic.length === 0 && !query
                    ? "No known options — type arguments, then Insert."
                    : "No match — press Enter to add as typed."}
                </div>
              )}
            </div>
          )}
        </div>

        {chosen && (
          <div className="cmd-foot">
            <button className="cmd-insert" onClick={insert} disabled={!finalCommand}>
              Insert
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
