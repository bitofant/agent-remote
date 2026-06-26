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
// Commands run in shell (Terminal) sessions, captured via shell integration with
// the cwd they ran in. Powers the command builder's recent/frequent lists —
// replacing the old practice of scraping the user's ~/.zsh_history files.
db.exec(
  `CREATE TABLE IF NOT EXISTS commands (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     command TEXT NOT NULL,
     cwd TEXT NOT NULL,
     ran_at INTEGER NOT NULL
   )`,
);
db.exec("CREATE INDEX IF NOT EXISTS commands_ran_at ON commands(ran_at)");
db.exec("CREATE INDEX IF NOT EXISTS commands_cwd ON commands(cwd)");

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

// --- command log -----------------------------------------------------------

// Cap the table so it can't grow without bound; pruned probabilistically on
// insert (the exact ceiling doesn't matter, only that it stays bounded).
const COMMAND_RETENTION = 10_000;

const recordCommandStmt = db.prepare(
  "INSERT INTO commands (command, cwd, ran_at) VALUES (?, ?, ?)",
);
const pruneCommandsStmt = db.prepare(
  `DELETE FROM commands
   WHERE id NOT IN (SELECT id FROM commands ORDER BY id DESC LIMIT ?)`,
);
// Recent: distinct commands, those run in the given cwd first (by recency there),
// then the rest by overall recency.
const recentCommandsStmt = db.prepare(
  `SELECT command FROM commands
   GROUP BY command
   ORDER BY MAX(CASE WHEN cwd = ? THEN ran_at END) IS NULL,
            MAX(CASE WHEN cwd = ? THEN ran_at END) DESC,
            MAX(ran_at) DESC
   LIMIT ?`,
);
// Frequent: distinct commands by overall count, those ever run in the given cwd
// first; ties broken by recency.
const frequentCommandsStmt = db.prepare(
  `SELECT command FROM commands
   GROUP BY command
   ORDER BY SUM(CASE WHEN cwd = ? THEN 1 ELSE 0 END) = 0,
            COUNT(*) DESC,
            MAX(ran_at) DESC
   LIMIT ?`,
);

/** Record a command run in a shell session, with the cwd it ran in. */
export function recordCommand(command: string, cwd: string, ts = Date.now()): void {
  recordCommandStmt.run(command, cwd, ts);
  if (Math.random() < 0.01) pruneCommandsStmt.run(COMMAND_RETENTION);
}

export function recentCommands(cwd: string, limit: number): string[] {
  return (recentCommandsStmt.all(cwd, cwd, limit) as { command: string }[]).map(
    (r) => r.command,
  );
}

export function frequentCommands(cwd: string, limit: number): string[] {
  return (frequentCommandsStmt.all(cwd, limit) as { command: string }[]).map(
    (r) => r.command,
  );
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

// --- shutdown --------------------------------------------------------------

/** Flush the WAL back into the main .db file and close. Without this, a dev
 * server that is only ever SIGKILLed leaves every write stranded in the WAL
 * and the .db file empty — recoverable, but the file is not self-sufficient. */
export function closeDb(): void {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
