// `~` is shell syntax, not a filesystem path: Node's fs/spawn treat it as a
// literal directory name, so a folder typed as `~/src/foo` never resolves.
// Expanded once at the WS entry points (index.ts) so everything downstream —
// DB rows, the folder allowlist, session cwd — only ever sees absolute paths.

import { homedir } from "node:os";
import { join } from "node:path";

/** Expand a leading `~` (bare or `~/…`) to the service user's home directory.
 * `~user/…` is deliberately unsupported (needs passwd lookup) and passes through. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Canonical form of a folder path: expanded, with a trailing slash.
 * The trailing slash isn't cosmetic — the path is the `folders` primary key and
 * is compared against session cwds, so `/x/y` and `/x/y/` would otherwise be two
 * folders. Idempotent; empty input stays empty (callers default it themselves). */
export function normalizeFolder(path: string): string {
  const expanded = expandHome(path);
  if (!expanded || expanded.endsWith("/")) return expanded;
  return `${expanded}/`;
}
