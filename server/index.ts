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
  closeDb,
} from "./db.js";
import { listCommands, resolveCommand, RESOLVER_IDS } from "./commands.js";
import { authedUser, handleAuthRoute } from "./auth.js";
import type {
  ClientMessage,
  HarnessInfo,
  ServerMessage,
} from "../shared/protocol.js";

// Single-port server. The whole app — UI, /api, and /ws — listens on one port.
// In dev (--dev) Vite runs in middleware mode on this same server, providing
// the UI and HMR. In production we serve the prebuilt assets from dist/web.
const DEV = process.argv.includes("--dev");

const config = loadConfig();
const adapters = buildAdapters(config);
const manager = new SessionManager(adapters);
const PORT = config.server?.port ?? 4000;

const harnesses: HarnessInfo[] = [...adapters.values()].map((a) => ({
  id: a.id,
  name: a.name,
}));

// One server-global subscriber that records every command run, with the cwd it
// ran in, for the command builder's recent/frequent lists. This must NOT live in
// the per-connection subscription below, or each connected browser would record
// a duplicate. Only shell sessions emit command events.
manager.subscribe({
  onStarted() {},
  onOutput() {},
  onExit() {},
  onEvent(sessionId, event) {
    if (event.type !== "command-start") return;
    const command = event.command.trim();
    const cwd = manager.sessionCwd(sessionId) ?? "";
    if (command && cwd) recordCommand(command, cwd, event.at);
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
    // Only list folders the user has already opened — keep this from doubling as
    // an arbitrary filesystem browser. (The cwd is always a known folder in the
    // UI.) PATH/alias data is the same regardless of which folder is passed.
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
    // Same folder allowlist as /api/commands, and the resolver id must be one we
    // know — the client never supplies a command to run, only its id.
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

// --- WebSocket (/ws) -------------------------------------------------------
// noServer + manual upgrade routing so our /ws coexists with Vite's HMR socket
// on the same port.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    // The core security boundary: no PTY is reachable without a valid session.
    // Cookies ride along on the upgrade request (same-origin) automatically.
    if (!authedUser(req, config)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  }
  // Other upgrades (e.g. Vite HMR) are handled by Vite's own upgrade listener.
});

// All live connections, so folder changes can be broadcast to every browser
// (folder history is server-owned, shared state — not per-connection).
const connections = new Set<WebSocket>();
function broadcastFolders(): void {
  const msg: ServerMessage = { type: "folders", folders: listFolders() };
  const raw = JSON.stringify(msg);
  for (const ws of connections) ws.send(raw);
}

wss.on("connection", (ws: WebSocket) => {
  const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));
  connections.add(ws);

  // Bring the new client up to date: folders, current sessions, then scrollback.
  send({ type: "folders", folders: listFolders() });
  send({ type: "sessions", sessions: manager.list() });
  for (const session of manager.list()) {
    const buffer = manager.buffer(session.id);
    if (buffer) send({ type: "output", sessionId: session.id, data: buffer });
  }

  const unsubscribe = manager.subscribe({
    onStarted: (session) => send({ type: "started", session }),
    onOutput: (sessionId, data) => send({ type: "output", sessionId, data }),
    onExit: (sessionId, exitCode) => send({ type: "exit", sessionId, exitCode }),
    onRemoved: (sessionId) => send({ type: "removed", sessionId }),
    onEvent: (sessionId, event) =>
      send({ type: "sessionEvent", sessionId, event }),
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
          manager.start(msg.harnessId, { cwd });
          // Launching a session registers/bumps its folder for everyone.
          upsertFolder(cwd);
          broadcastFolders();
          break;
        }
        case "input":
          manager.input(msg.sessionId, msg.data);
          break;
        case "resize":
          manager.resize(msg.sessionId, msg.cols, msg.rows);
          break;
        case "stop":
          manager.stop(msg.sessionId);
          break;
        case "remove":
          manager.remove(msg.sessionId);
          break;
        case "addFolder":
          upsertFolder(msg.path);
          broadcastFolders();
          break;
        case "removeFolder":
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

// Fail loudly on a port collision instead of letting the process linger idle.
// (A stranded older dev server holding the port is how stale code keeps serving
// while every "restart" silently fails to bind.)
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

// Checkpoint the WAL and close the DB cleanly on shutdown (tsx watch sends
// SIGTERM on each reload; Ctrl-C sends SIGINT).
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
