import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { enabledUsers, type Config } from "./config.js";
import {
  createAuthSession,
  createUser,
  deleteAuthSession,
  getAuthSession,
  getUser,
  setUserPassword,
} from "./db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { clientIp, FailureLimiter } from "./rateLimit.js";

// All authentication: password hashing, cookies, HTTP auth routes. The rest of
// the server only asks "who is this request?" via authedUser(). Sessions are
// server-side sqlite tokens in an HttpOnly cookie, never exposed to page JS.

const COOKIE_NAME = "agent_remote_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_FIELD_LEN = 256;

const MIN = 60_000;
// Per IP: 5 free failures, then 1s, 2s, 4s… capped at 15 min.
const loginByIp = new FailureLimiter({
  freeAttempts: 5,
  baseLockMs: 1000,
  maxLockMs: 15 * MIN,
  forgetMs: 60 * MIN,
  maxKeys: 10_000,
});
// Per username, against distributed guessing. Looser than per-IP, since anyone
// can trip it and so lock the real owner out for a while.
const loginByUser = new FailureLimiter({
  freeAttempts: 10,
  baseLockMs: 1000,
  maxLockMs: 15 * MIN,
  forgetMs: 60 * MIN,
  maxKeys: 10_000,
});
// Open registration only: every attempt counts (rows + scrypt are the cost).
const registerByIp = new FailureLimiter({
  freeAttempts: 3,
  baseLockMs: MIN,
  maxLockMs: 60 * MIN,
  forgetMs: 24 * 60 * MIN,
  maxKeys: 10_000,
});

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

/** Username if the request has a valid session AND is still in config.json's
 * users (live-reloaded, so removing a name revokes at once); else null. */
export function authedUser(req: IncomingMessage, config: Config): string | null {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const username = getAuthSession(token);
  if (!username) return null;
  return enabledUsers(config).includes(username) ? username : null;
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

function tooMany(res: ServerResponse, waitMs: number): void {
  const sec = Math.ceil(waitMs / 1000);
  sendJson(
    res,
    429,
    { message: `Too many attempts. Try again in ${formatWait(sec)}.` },
    { "retry-after": String(sec) },
  );
}

function formatWait(sec: number): string {
  if (sec < 60) return `${sec}s`;
  return `${Math.ceil(sec / 60)} min`;
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
function registrationMode(config: Config): "open" | "closed" {
  return config.registration === "open" ? "open" : "closed";
}

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

  if (req.method === "GET" && url === "/api/auth-info") {
    sendJson(res, 200, { registration: registrationMode(config) });
    return true;
  }

  if (req.method === "POST" && url === "/api/register") {
    if (registrationMode(config) !== "open") {
      sendJson(res, 403, {
        message:
          "Registration is closed. Ask the admin to create your account (npm run add-user).",
      });
      return true;
    }
    const ip = clientIp(req);
    const wait = registerByIp.retryAfterMs(ip);
    if (wait > 0) {
      tooMany(res, wait);
      return true;
    }
    const creds = readCredentials(await readJsonBody(req).catch(() => null));
    if (!creds) {
      sendJson(res, 400, { message: "Username and password are required." });
      return true;
    }
    registerByIp.fail(ip);
    if (getUser(creds.username)) {
      sendJson(res, 409, { message: "That username is already taken." });
      return true;
    }
    const hash = await hashPassword(creds.password);
    try {
      createUser(creds.username, hash);
    } catch {
      // Lost a race with a concurrent registration of the same name.
      sendJson(res, 409, { message: "That username is already taken." });
      return true;
    }
    // Registration never logs in, and doesn't reveal whether the name is
    // enabled: the account is unusable until it's in config.json's users.
    sendJson(res, 200, {
      message: "Registered. You can log in once the admin enables your account.",
    });
    return true;
  }

  if (req.method === "POST" && url === "/api/login") {
    const creds = readCredentials(await readJsonBody(req).catch(() => null));
    if (!creds) {
      sendJson(res, 400, { message: "Username and password are required." });
      return true;
    }
    const ip = clientIp(req);
    const wait = Math.max(
      loginByIp.retryAfterMs(ip),
      loginByUser.retryAfterMs(creds.username),
    );
    // Locked: refuse before checking, so a lockout is not a password oracle.
    if (wait > 0) {
      tooMany(res, wait);
      return true;
    }
    // Count up front: the check is async, so a parallel burst would otherwise
    // all pass the lock before any failure lands.
    loginByIp.fail(ip);
    loginByUser.fail(creds.username);
    const user = getUser(creds.username);
    // Unknown user still pays a full scrypt; same generic error either way.
    if (!(await verifyPassword(creds.password, user?.passwordHash))) {
      sendJson(res, 401, { message: "Invalid username or password." });
      return true;
    }
    loginByIp.succeed(ip);
    loginByUser.succeed(creds.username);
    if (!enabledUsers(config).includes(creds.username)) {
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

  if (req.method === "POST" && url === "/api/change-password") {
    const username = authedUser(req, config);
    if (!username) {
      sendJson(res, 401, { message: "Not logged in." });
      return true;
    }
    const data = (await readJsonBody(req).catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const current = data?.current;
    const next = data?.next;
    if (
      typeof current !== "string" ||
      typeof next !== "string" ||
      !current ||
      !next ||
      current.length > MAX_FIELD_LEN ||
      next.length > MAX_FIELD_LEN
    ) {
      sendJson(res, 400, { message: "Current and new password are required." });
      return true;
    }
    // Same limiters as login: a stolen cookie mustn't make this a guessing oracle.
    const ip = clientIp(req);
    const wait = Math.max(
      loginByIp.retryAfterMs(ip),
      loginByUser.retryAfterMs(username),
    );
    if (wait > 0) {
      tooMany(res, wait);
      return true;
    }
    loginByIp.fail(ip);
    loginByUser.fail(username);
    if (!(await verifyPassword(current, getUser(username)?.passwordHash))) {
      sendJson(res, 401, { message: "Current password is incorrect." });
      return true;
    }
    loginByIp.succeed(ip);
    loginByUser.succeed(username);
    // Logs out every session (incl. this one), then re-issues this one's.
    setUserPassword(username, await hashPassword(next));
    const token = randomBytes(32).toString("hex");
    createAuthSession(token, username, Date.now() + SESSION_TTL_MS);
    sendJson(
      res,
      200,
      { message: "Password changed. Other devices have been logged out." },
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
