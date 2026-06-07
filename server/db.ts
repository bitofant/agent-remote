import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { FolderInfo } from "../shared/protocol.js";

// The project's only persistence layer. Sessions are live PTYs and can't
// survive a restart, but the folders the user has worked in are remembered
// here, along with registered user accounts and their login sessions, so all
// survive restarts and are shared across browsers via the server.

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
db.exec(
  `CREATE TABLE IF NOT EXISTS users (
     username TEXT PRIMARY KEY,
     password_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
);
// Login sessions, keyed by an opaque random token kept in the browser's cookie.
// Named auth_sessions to avoid confusion with the live agent (PTY) sessions.
db.exec(
  `CREATE TABLE IF NOT EXISTS auth_sessions (
     token TEXT PRIMARY KEY,
     username TEXT NOT NULL,
     expires_at INTEGER NOT NULL
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

// --- users & auth sessions -------------------------------------------------

export interface UserRow {
  username: string;
  passwordHash: string;
}

const getUserStmt = db.prepare(
  "SELECT username, password_hash AS passwordHash FROM users WHERE username = ?",
);
const createUserStmt = db.prepare(
  "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
);
const createAuthSessionStmt = db.prepare(
  "INSERT INTO auth_sessions (token, username, expires_at) VALUES (?, ?, ?)",
);
const getAuthSessionStmt = db.prepare(
  "SELECT username, expires_at AS expiresAt FROM auth_sessions WHERE token = ?",
);
const deleteAuthSessionStmt = db.prepare(
  "DELETE FROM auth_sessions WHERE token = ?",
);

export function getUser(username: string): UserRow | undefined {
  return getUserStmt.get(username) as UserRow | undefined;
}

export function createUser(username: string, passwordHash: string): void {
  createUserStmt.run(username, passwordHash, Date.now());
}

export function createAuthSession(
  token: string,
  username: string,
  expiresAt: number,
): void {
  createAuthSessionStmt.run(token, username, expiresAt);
}

/** The session's username if the token exists and hasn't expired; otherwise
 * undefined. Expired rows are deleted lazily on lookup. */
export function getAuthSession(token: string): string | undefined {
  const row = getAuthSessionStmt.get(token) as
    | { username: string; expiresAt: number }
    | undefined;
  if (!row) return undefined;
  if (row.expiresAt <= Date.now()) {
    deleteAuthSessionStmt.run(token);
    return undefined;
  }
  return row.username;
}

export function deleteAuthSession(token: string): void {
  deleteAuthSessionStmt.run(token);
}
