// Directory browser for the add-folder picker. Deliberately NOT confined like
// files.ts: you're picking a folder that isn't known yet, so there is no root to
// confine to — and typing an arbitrary path by hand always reached just as far.
// It only ever returns directory *names*, never file contents.

import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BrowseListing } from "../shared/protocol.js";
import { expandHome, normalizeFolder } from "./paths.js";

// Cap so one huge directory can't ship a megabyte of names to the browser.
const MAX_ENTRIES = 1000;

/** List the subdirectories of `path` (`~` accepted, empty = home). Symlinks are
 * followed so linked project dirs are browsable; unreadable ones are skipped. */
export async function browseDirs(path: string): Promise<BrowseListing> {
  const dir = resolve(expandHome(path.trim() || "~"));
  const dirents = await readdir(dir, { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      // The client shows these verbatim in the tree; raw ENOENT/scandir noise
      // isn't something a user should have to read.
      if (err.code === "ENOENT") throw new Error("No such folder.");
      if (err.code === "EACCES" || err.code === "EPERM")
        throw new Error("Permission denied.");
      if (err.code === "ENOTDIR") throw new Error("Not a folder.");
      throw err;
    },
  );
  const names: string[] = [];
  for (const d of dirents) {
    if (d.isDirectory()) names.push(d.name);
    else if (d.isSymbolicLink()) {
      const target = await stat(join(dir, d.name)).catch(() => null);
      if (target?.isDirectory()) names.push(d.name);
    }
  }
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const parent = dirname(dir);
  return {
    path: normalizeFolder(dir),
    parent: parent === dir ? null : normalizeFolder(parent),
    entries: names.slice(0, MAX_ENTRIES).map((name) => ({
      name,
      path: normalizeFolder(join(dir, name)),
    })),
    ...(names.length > MAX_ENTRIES ? { truncated: true } : {}),
  };
}
