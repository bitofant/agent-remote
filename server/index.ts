import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { buildAdapters } from "./adapters/registry.js";
import { SessionManager } from "./sessions/manager.js";
import {
  listFolders,
  upsertFolder,
  removeFolder,
  recordCommand,
  upsertChatSession,
  setChatSessionTitle,
  listResumableSessions,
  deleteChatSession,
  listChatRenderLog,
  closeDb,
} from "./db.js";
import { recordChatRenders, forgetChatRenders } from "./chatLog.js";
import { listCommands, resolveCommand, RESOLVER_IDS } from "./commands.js";
import { listDir, readTextFile, writeTextFile } from "./files.js";
import { authedUser, handleAuthRoute } from "./auth.js";
import { startLlmPolling, llmStatus, evaluate } from "./llm.js";
import type {
  ClientMessage,
  HarnessInfo,
  LlmEvaluateRequest,
  ServerMessage,
} from "../shared/protocol.js";

// Single port for UI, /api, and /ws. Dev (--dev): Vite in middleware mode on
// this server (UI + HMR). Prod: serve prebuilt dist/web.
const DEV = process.argv.includes("--dev");

const config = loadConfig();
const adapters = buildAdapters(config);
const manager = new SessionManager(adapters);
const PORT = config.server?.port ?? 4000;

// Best-effort LLM assist: poll the configured endpoint's health in the
// background. Never blocks startup; unavailable is fine.
startLlmPolling(config.llm);

const harnesses: HarnessInfo[] = [...adapters.values()].map((a) => ({
  id: a.id,
  name: a.name,
}));

// Server-global subscriber recording every command run (with cwd) for the
// builder's recent/frequent lists. Must NOT live in the per-connection
// subscription below, or each browser would double-record.
manager.subscribe({
  onStarted() {},
  onOutput() {},
  onExit() {},
  onEvent(sessionId, event) {
    if (event.type !== "command-start") return;
    // Chat sessions mirror busy via command events — those are prompts, not
    // shell commands; keep them out of recents.
    if (manager.sessionUi(sessionId) === "chat") return;
    const command = event.command.trim();
    const cwd = manager.sessionCwd(sessionId) ?? "";
    if (command && cwd) recordCommand(command, cwd, event.at);
  },
  // Persist resumable chat sessions (DB is the source of truth for the resume
  // list): record the key at init, set the title from the first user prompt.
  onResumable(sessionId, key) {
    const info = manager.sessionInfo(sessionId);
    const folder = manager.sessionFolder(sessionId);
    if (!info || !folder) return;
    upsertChatSession({
      resumeKey: key,
      harnessId: info.harnessId,
      harnessName: info.harnessName,
      folder,
    });
  },
  onChatEvent(sessionId, event) {
    // Log finalized-message renders (diagnostics). Skip high-frequency streaming
    // events — final form lands on assistant-end/tool-end; chatLog dedupes.
    if (event.type !== "part-delta" && event.type !== "tool-update") {
      const state = manager.chatState(sessionId);
      const info = manager.sessionInfo(sessionId);
      if (state)
        recordChatRenders(sessionId, state, {
          harnessId: info?.harnessId,
          cwd: info?.cwd,
        });
    }
    if (event.type !== "user-message") return;
    const key = manager.resumeKey(sessionId);
    if (!key) return;
    const text = event.message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim()
      .split("\n", 1)[0];
    if (text) setChatSessionTitle(key, text.slice(0, 120));
  },
  onRemoved(sessionId) {
    forgetChatRenders(sessionId);
  },
});

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;
let viteMiddlewares: Middleware | undefined;

const server = createHttpServer((req, res) => {
  // Auth routes (login/register/logout/me) are always reachable.
  void handleAuthRoute(req, res, config).then((handled) => {
    if (handled) return;
    routeAfterAuth(req, res);
  });
});

function routeAfterAuth(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";
  if (req.method === "GET" && url === "/api/harnesses") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(harnesses));
    return;
  }
  if (req.method === "GET" && url.startsWith("/api/commands")) {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const cwd = new URL(url, "http://x").searchParams.get("cwd") ?? "";
    // Allowlist to opened folders so this isn't an arbitrary filesystem browser.
    if (!listFolders().some((f) => f.path === cwd)) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "Unknown folder." }));
      return;
    }
    void listCommands(cwd).then(
      (listing) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(listing));
      },
      (err: unknown) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: (err as Error).message }));
      },
    );
    return;
  }
  if (req.method === "GET" && url.startsWith("/api/resolve")) {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const id = params.get("id") ?? "";
    const cwd = params.get("cwd") ?? "";
    // Folder allowlist + known resolver id (client supplies only an id, never a command).
    if (!RESOLVER_IDS.has(id) || !listFolders().some((f) => f.path === cwd)) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "Unknown resolver or folder." }));
      return;
    }
    void resolveCommand(id, cwd).then(
      (result) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      },
      (err: unknown) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: (err as Error).message }));
      },
    );
    return;
  }
  // Resumable chat sessions for a folder (GET) / forget one (DELETE).
  if (url.startsWith("/api/resumable")) {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    if (req.method === "GET") {
      const cwd = params.get("cwd") ?? "";
      if (!listFolders().some((f) => f.path === cwd))
        return sendJsonError(res, 400, "Unknown folder.");
      // Hide sessions that are currently open — you resume closed ones.
      const live = manager.liveResumeKeys();
      const sessions = listResumableSessions(cwd).filter(
        (s) => !live.has(s.resumeKey),
      );
      return sendJson(res, sessions);
    }
    if (req.method === "DELETE") {
      const key = params.get("key") ?? "";
      if (key) deleteChatSession(key);
      return sendJson(res, { ok: true });
    }
  }
  // Chat render log (read-only diagnostics). ?session= filters, ?limit= caps rows.
  if (req.method === "GET" && url.startsWith("/api/chat-log")) {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const session = params.get("session") || undefined;
    const limit = Math.min(
      Math.max(Number(params.get("limit")) || 100, 1),
      1000,
    );
    return sendJson(res, listChatRenderLog(limit, session));
  }
  // Optional LLM assist. Status is cheap/cached; evaluate is stateless and
  // fail-safe (assistant-mode state lives entirely client-side).
  if (req.method === "GET" && url === "/api/llm-status") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    return sendJson(res, llmStatus());
  }
  if (req.method === "POST" && url === "/api/llm-evaluate") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    void readTextBody(req)
      .then((body) => evaluate(JSON.parse(body) as LlmEvaluateRequest))
      .then(
        (decision) => sendJson(res, decision),
        // Any failure (bad body, endpoint down) is a non-event for the UI.
        () => sendJson(res, { available: false }),
      );
    return;
  }
  // File editor: list/read/write under a known folder root (files.ts confines
  // every path to it).
  const pathname = new URL(url, "http://x").pathname;
  if (pathname === "/api/files" && req.method === "GET") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const cwd = params.get("cwd") ?? "";
    const path = params.get("path") ?? "";
    if (!listFolders().some((f) => f.path === cwd))
      return sendJsonError(res, 400, "Unknown folder.");
    void listDir(cwd, path).then(
      (listing) => sendJson(res, listing),
      (err: unknown) => sendJsonError(res, 400, (err as Error).message),
    );
    return;
  }
  if (pathname === "/api/file") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const cwd = params.get("cwd") ?? "";
    const path = params.get("path") ?? "";
    if (!listFolders().some((f) => f.path === cwd))
      return sendJsonError(res, 400, "Unknown folder.");
    if (req.method === "GET") {
      void readTextFile(cwd, path).then(
        (file) => sendJson(res, file),
        (err: unknown) => sendJsonError(res, 400, (err as Error).message),
      );
      return;
    }
    if (req.method === "PUT") {
      void readTextBody(req)
        .then((content) => writeTextFile(cwd, path, content))
        .then(
          () => sendJson(res, { ok: true }),
          (err: unknown) => sendJsonError(res, 400, (err as Error).message),
        );
      return;
    }
  }
  if (viteMiddlewares) {
    viteMiddlewares(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
    return;
  }
  serveStatic(req.url ?? "/", res);
}

function sendUnauthorized(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message: "Not logged in." }));
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message }));
}

// Read a raw text request body (PUT /api/file), capped so one write can't
// exhaust memory (matches files.ts's MAX_FILE_BYTES).
function readTextBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) reject(new Error("File is too large."));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// --- WebSocket (/ws) -------------------------------------------------------
// noServer + manual upgrade routing so /ws coexists with Vite's HMR socket.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    // Security boundary: no PTY reachable without a valid session (cookies ride
    // the same-origin upgrade request).
    if (!authedUser(req, config)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  }
  // Other upgrades (Vite HMR) handled by Vite's own upgrade listener.
});

// All live connections, so server-owned folder history can be broadcast to
// every browser.
const connections = new Set<WebSocket>();
function broadcastFolders(): void {
  const msg: ServerMessage = { type: "folders", folders: listFolders() };
  const raw = JSON.stringify(msg);
  for (const ws of connections) ws.send(raw);
}

// Every input bumps its folder's timestamp (folders sort by last_used_at DESC),
// but the broadcast only matters when the *order* changes. lastActiveFolder
// suppresses the redundant re-broadcast per keystroke in the same folder.
let lastActiveFolder: string | undefined;

function markFolderActive(folder: string): void {
  upsertFolder(folder);
  if (folder === lastActiveFolder) return;
  lastActiveFolder = folder;
  broadcastFolders();
}

// Strip terminal report requests (Device Attributes `…c`, Device Status `…n`)
// from replayed scrollback — replaying them makes xterm re-answer into an idle
// prompt, echoing the reply as literal text (e.g. `1;2c`). Live output untouched.
const stripReports = (s: string): string =>
  s.replace(/\x1b\[[?>=]?[0-9;]*[cn]/g, "");

wss.on("connection", (ws: WebSocket) => {
  const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));
  connections.add(ws);

  // Bring the new client up to date: folders, sessions, then history
  // (scrollback for terminals, a chat-state snapshot for chat sessions).
  send({ type: "folders", folders: listFolders() });
  send({ type: "sessions", sessions: manager.list() });
  for (const session of manager.list()) {
    if (session.ui === "chat") {
      const state = manager.chatState(session.id);
      if (state) send({ type: "chatState", sessionId: session.id, state });
      continue;
    }
    const buffer = manager.buffer(session.id);
    if (buffer)
      send({ type: "output", sessionId: session.id, data: stripReports(buffer) });
  }

  const unsubscribe = manager.subscribe({
    onStarted: (session) => send({ type: "started", session }),
    onOutput: (sessionId, data) => send({ type: "output", sessionId, data }),
    onExit: (sessionId, exitCode) => send({ type: "exit", sessionId, exitCode }),
    onRemoved: (sessionId) => send({ type: "removed", sessionId }),
    onEvent: (sessionId, event) =>
      send({ type: "sessionEvent", sessionId, event }),
    onChatEvent: (sessionId, event) =>
      send({ type: "chatEvent", sessionId, event }),
  });

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case "start": {
          const cwd = msg.cwd || process.cwd();
          manager.start(msg.harnessId, { cwd, resume: msg.resume });
          // Launching registers/bumps its folder for everyone.
          lastActiveFolder = cwd;
          upsertFolder(cwd);
          broadcastFolders();
          break;
        }
        case "input": {
          manager.input(msg.sessionId, msg.data);
          // Typing bumps its folder to the top of the list.
          const folder = manager.sessionFolder(msg.sessionId);
          if (folder) markFolderActive(folder);
          break;
        }
        case "resize":
          manager.resize(msg.sessionId, msg.cols, msg.rows);
          break;
        case "chatAction": {
          manager.chatAction(msg.sessionId, msg.action);
          // Prompting bumps its folder like terminal input.
          const folder = manager.sessionFolder(msg.sessionId);
          if (folder) markFolderActive(folder);
          break;
        }
        case "stop":
          manager.stop(msg.sessionId);
          break;
        case "remove":
          manager.remove(msg.sessionId);
          break;
        case "addFolder":
          lastActiveFolder = msg.path;
          upsertFolder(msg.path);
          broadcastFolders();
          break;
        case "removeFolder":
          if (msg.path === lastActiveFolder) lastActiveFolder = undefined;
          removeFolder(msg.path);
          broadcastFolders();
          break;
      }
    } catch (err) {
      send({ type: "error", message: (err as Error).message });
    }
  });

  ws.on("close", () => {
    unsubscribe();
    connections.delete(ws);
  });
});

// --- Static serving of the built frontend (production) ---------------------
const WEB_DIST = resolve(process.cwd(), "dist/web");
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function serveStatic(url: string, res: ServerResponse): void {
  if (!existsSync(WEB_DIST)) {
    res.statusCode = 404;
    res.end("Frontend not built. Run `npm run build`, or `npm run dev`.");
    return;
  }
  const path = url.split("?")[0];
  // Resolve within WEB_DIST, falling back to index.html for SPA routes.
  const candidate = normalize(
    join(WEB_DIST, path === "/" ? "/index.html" : path),
  );
  const file =
    candidate.startsWith(WEB_DIST) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
      ? candidate
      : join(WEB_DIST, "index.html");
  res.setHeader(
    "content-type",
    CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
  );
  res.end(readFileSync(file));
}

// --- Dev: embed Vite in middleware mode (same port, with HMR) --------------
if (DEV) {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  viteMiddlewares = vite.middlewares as unknown as Middleware;
}

// Fail loudly on a port collision — a stranded older server holding the port is
// how stale code keeps serving while every "restart" silently fails to bind.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use — another agent-remote server is ` +
        `probably still running. Stop it first:\n` +
        `  pkill -f "tsx watch server/index.ts"`,
    );
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});

// Checkpoint the WAL and close the DB cleanly on shutdown (tsx watch → SIGTERM
// on reload; Ctrl-C → SIGINT).
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  closeDb();
  console.log(`\nagent-remote stopped (${signal}).`);
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => shutdown(sig));
}

server.listen(PORT, () => {
  console.log(
    `agent-remote ${DEV ? "(dev) " : ""}listening on http://localhost:${PORT}`,
  );
});
