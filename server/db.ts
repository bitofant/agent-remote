import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { FolderInfo } from "../shared/protocol.js";

// The project's only persistence layer. Sessions are live PTYs and can't
// survive a restart, but the folders the user has worked in are remembered
// here so the left menu can list them most-recent-first across restarts and
// share them across browsers via the server.

const DB_PATH = resolve(process.cwd(), "data/agent-remote.db");

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(
  `CREATE TABLE IF NOT EXISTS folders (
     path TEXT PRIMARY KEY,
     last_used_at INTEGER NOT NULL
   )`,
);

const listStmt = db.prepare(
  "SELECT path, last_used_at AS lastUsedAt FROM folders ORDER BY last_used_at DESC",
);
const upsertStmt = db.prepare(
  `INSERT INTO folders (path, last_used_at) VALUES (?, ?)
   ON CONFLICT(path) DO UPDATE SET last_used_at = excluded.last_used_at`,
);
const removeStmt = db.prepare("DELETE FROM folders WHERE path = ?");

export function listFolders(): FolderInfo[] {
  return listStmt.all() as FolderInfo[];
}

/** Insert the folder, or bump its recency if already known. */
export function upsertFolder(path: string, ts = Date.now()): void {
  upsertStmt.run(path, ts);
}

export function removeFolder(path: string): void {
  removeStmt.run(path);
}
