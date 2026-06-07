import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import {
  createAuthSession,
  createUser,
  deleteAuthSession,
  getAuthSession,
  getUser,
} from "./db.js";

// All authentication lives here: password hashing, cookie handling, and the
// HTTP auth routes. The rest of the server only asks "who is this request?"
// via authedUser(). Sessions are server-side tokens stored in sqlite and
// carried in an HttpOnly cookie, so the token is never exposed to page JS.

const COOKIE_NAME = "agent_remote_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_FIELD_LEN = 256;

// --- password hashing ------------------------------------------------------

/** Hash a password as `salt:derivedKeyHex` using scrypt. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

/** Constant-time check of a password against a stored `salt:hash`. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}

// --- cookies ---------------------------------------------------------------

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = part.slice(idx + 1).trim();
  }
  return out;
}

function sessionCookie(
  req: IncomingMessage,
  token: string,
  maxAgeSec: number,
): string {
  // Secure only over real https; behind a proxy this header reflects it.
  const secure = req.headers["x-forwarded-proto"] === "https";
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// --- request authentication ------------------------------------------------

/** The username making this request, if it carries a valid session whose user
 * is still enabled in config; otherwise null. Re-checking config membership on
 * every request means removing a name from config.json revokes access at once. */
export function authedUser(req: IncomingMessage, config: Config): string | null {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const username = getAuthSession(token);
  if (!username) return null;
  return config.users.includes(username) ? username : null;
}

// --- HTTP auth routes ------------------------------------------------------

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function readCredentials(
  data: unknown,
): { username: string; password: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const { username, password } = data as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") return null;
  const trimmed = username.trim();
  if (!trimmed || !password) return null;
  if (trimmed.length > MAX_FIELD_LEN || password.length > MAX_FIELD_LEN) {
    return null;
  }
  return { username: trimmed, password };
}

/**
 * Handle the auth endpoints. Returns true if the request was an auth route
 * (and a response has been sent), false to let the caller handle it.
 */
export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
): Promise<boolean> {
  const url = req.url ?? "";

  if (req.method === "GET" && url === "/api/me") {
    const username = authedUser(req, config);
    if (username) sendJson(res, 200, { username });
    else sendJson(res, 401, { message: "Not logged in." });
    return true;
  }

  if (req.method === "POST" && url === "/api/register") {
    const creds = readCredentials(await readJsonBody(req).catch(() => null));
    if (!creds) {
      sendJson(res, 400, { message: "Username and password are required." });
      return true;
    }
    if (getUser(creds.username)) {
      sendJson(res, 409, { message: "That username is already taken." });
      return true;
    }
    createUser(creds.username, hashPassword(creds.password));
    // Registration never logs in: the account is unusable until an admin adds
    // the name to the "users" list in config.json.
    const enabled = config.users.includes(creds.username);
    sendJson(res, 200, {
      message: enabled
        ? "Registered. Your account is enabled — you can log in now."
        : "Registered. Ask the admin to add your name to config.json, then log in.",
    });
    return true;
  }

  if (req.method === "POST" && url === "/api/login") {
    const creds = readCredentials(await readJsonBody(req).catch(() => null));
    if (!creds) {
      sendJson(res, 400, { message: "Username and password are required." });
      return true;
    }
    const user = getUser(creds.username);
    // Generic error on any credential mismatch — no username enumeration.
    if (!user || !verifyPassword(creds.password, user.passwordHash)) {
      sendJson(res, 401, { message: "Invalid username or password." });
      return true;
    }
    if (!config.users.includes(creds.username)) {
      sendJson(res, 403, {
        message: `Account "${creds.username}" is not enabled. Add "${creds.username}" to the "users" list in config.json.`,
      });
      return true;
    }
    const token = randomBytes(32).toString("hex");
    createAuthSession(token, creds.username, Date.now() + SESSION_TTL_MS);
    sendJson(
      res,
      200,
      { username: creds.username },
      { "set-cookie": sessionCookie(req, token, SESSION_TTL_MS / 1000) },
    );
    return true;
  }

  if (req.method === "POST" && url === "/api/logout") {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) deleteAuthSession(token);
    sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie(req, "", 0) });
    return true;
  }

  return false;
}
