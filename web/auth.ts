// Thin fetch wrappers around the server auth routes. The session lives in an
// HttpOnly cookie the browser sends automatically, so there is no token to
// store here — we only learn the current username from /api/me.

export interface AuthResult {
  ok: boolean;
  message?: string;
  username?: string;
}

async function postAuth(path: string, body: object): Promise<AuthResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, message: data.message, username: data.username };
}

export async function fetchMe(): Promise<string | null> {
  const res = await fetch("/api/me");
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return typeof data.username === "string" ? data.username : null;
}

export function login(username: string, password: string): Promise<AuthResult> {
  return postAuth("/api/login", { username, password });
}

export function register(
  username: string,
  password: string,
): Promise<AuthResult> {
  return postAuth("/api/register", { username, password });
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST" });
}
