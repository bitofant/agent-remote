// File-editor backend: browse subfolders and read/write files under a folder
// root. Deliberately narrow — it is NOT a general filesystem browser. Callers
// (index.ts) must first confirm `root` is a known folder; every path is then
// confined to that root here, so a request can never escape it via `..` or an
// absolute path.

import { readdir, readFile as fsReadFile, writeFile as fsWriteFile, stat } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import type { DirListing, FileContent, FileEntry } from "../shared/protocol.js";

// Refuse to read files larger than this (they aren't editable in a browser text
// field anyway) so we never buffer something huge into memory.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Resolve `rel` under `root`, guaranteeing the result stays inside `root`.
 * Throws on any attempt to escape (via `..`, an absolute path, etc.). */
function resolveWithin(root: string, rel: string): string {
  if (rel.includes("\0")) throw new Error("Invalid path.");
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, rel);
  const rootWithSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (target !== rootAbs && !target.startsWith(rootWithSep)) {
    throw new Error("Path is outside the folder.");
  }
  return target;
}

/** List the entries of a subdirectory under `root`. Directories first, then
 * files, each sorted case-insensitively. Hidden entries are included. */
export async function listDir(root: string, rel: string): Promise<DirListing> {
  const dir = resolveWithin(root, rel);
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: FileEntry[] = dirents
    .filter((d) => d.isFile() || d.isDirectory())
    .map((d) => ({
      name: d.name,
      // Relative to the root, POSIX-style, so the client can pass it straight
      // back on the next request.
      path: relative(resolve(root), join(dir, d.name)).split(sep).join("/"),
      type: d.isDirectory() ? ("dir" as const) : ("file" as const),
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  return { path: rel.split(sep).join("/"), entries };
}

/** Read a text file under `root`. Refuses directories, oversized files, and
 * binary files (a NUL byte in the content). */
export async function readTextFile(root: string, rel: string): Promise<FileContent> {
  const file = resolveWithin(root, rel);
  const info = await stat(file);
  if (info.isDirectory()) throw new Error("Path is a directory.");
  if (info.size > MAX_FILE_BYTES) throw new Error("File is too large to edit.");
  const buf = await fsReadFile(file);
  if (buf.includes(0)) throw new Error("File appears to be binary.");
  return { path: rel.split(sep).join("/"), content: buf.toString("utf8") };
}

/** Write (create or overwrite) a text file under `root`. */
export async function writeTextFile(
  root: string,
  rel: string,
  content: string,
): Promise<void> {
  const file = resolveWithin(root, rel);
  await fsWriteFile(file, content, "utf8");
}
