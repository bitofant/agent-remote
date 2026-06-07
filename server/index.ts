import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { buildAdapters } from "./adapters/registry.js";
import { SessionManager } from "./sessions/manager.js";
import { listFolders, upsertFolder, removeFolder } from "./db.js";
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
  if (req.method === "GET" && req.url === "/api/harnesses") {
    if (!authedUser(req, config)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "Not logged in." }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(harnesses));
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
    candidate.startsWith(WEB_DIST) && existsSync(candidate)
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

server.listen(PORT, () => {
  console.log(
    `agent-remote ${DEV ? "(dev) " : ""}listening on http://localhost:${PORT}`,
  );
});
