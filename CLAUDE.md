# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Everything in CLAUDE.md must be extremely terse: bulleted lists, not paragraphs, as concise and token-efficient as possible.**

**Keep this file correct: update it when details change, and add genuinely important architectural decisions as they're made.**

## Project state

- Scaffolded. Working vertical slice: launch Claude Code/pi sessions, stream live to xterm in the browser, type back, switch between concurrent sessions.
- TypeScript throughout. No tests yet (add a runner here when introduced).

## Commands

- `npm run dev` — single-process dev server (`tsx watch server/index.ts --dev`).
- `npm run build` — production frontend build to `dist/web` (Vite).
- `npm start` — run server serving the prebuilt `dist/web`.
- `npm run typecheck` — `tsc --noEmit` for web (`tsconfig.json`) + server (`tsconfig.server.json`).
- Requires `config.json` (run `./config-gen.sh`); the agent CLIs (`claude`, `pi`) must be on `PATH`.
- Server is **never compiled** — `npm start` runs `tsx server/index.ts` directly. Only the frontend is built (`dist/web`).

## Deployment (systemd user service)

- `./install-service.sh` — one-time: writes/enables `~/.config/systemd/user/agent-remote.service` (runs `npm start`), builds `dist/web` if missing, enables linger. User service (not system): agent CLIs live in per-user paths.
- `./start.sh` / `./stop.sh` / `./restart.sh` wrap `systemctl --user` as the canonical prod runner. `./restart.sh` rebuilds frontend then restarts.
- `./start.sh dev` is the exception: runs the `tsx watch` HMR server directly (pidfile + `setsid`, not systemd). `./stop.sh` prioritizes that pidfile if present, else stops the service.
- `./rebuild.sh` builds frontend only. Frontend change → rebuild + restart; server-only change → plain `systemctl --user restart agent-remote` (no build needed).

## Layout

- `shared/protocol.ts` — WS message + session types, shared by both sides. Harness-agnostic. Also `CommandListing` (the `/api/commands` response shape) and `SessionEvent` (command-start/end + cwd events).
- `server/` — Node backend. `config.ts` (loads `config.json`), `adapters/` (harness boundary, incl. `shell-integration/` injected rc scripts), `sessions/manager.ts` (PTY/streaming/lifecycle + session-event fan-out, harness-agnostic), `commands.ts` (lists cwd executables + `$PATH` + shell aliases + recent/frequent commands from the DB command log; PATH/alias cached 30s), `db.ts` (SQLite: folders, users, auth sessions, command log), `index.ts` (HTTP + WS + dev Vite).
- `web/` — React app. `client.ts` (WS client, per-session output buffering, sticky Ctrl modifier applied in `input()`), `TerminalView.tsx` (xterm per session), `App.tsx` (workspace + mobile keyboard key-bar), `CommandBuilder.tsx` (the `./` command-builder dialog), `commandCatalog.ts` (static well-known-command subcommand/flag data + curated common-command list), `styles.css`.
- **Command builder:** `./` key-bar button opens `CommandBuilder`. Lists recent/frequent (from the DB command log), cwd executables, then aliases/common/full-`$PATH` (server `GET /api/commands?cwd=` — auth'd, cwd must be a known folder). Picking a plain command then filters static subcommand/flag suggestions from `commandCatalog.ts` (free-text for unknown commands); picking a recent/frequent entry (a whole command line) inserts it directly. **Inserts** the assembled line into the PTY without a trailing newline — user reviews and presses Enter.
- **Recent/frequent commands:** sourced from the DB `commands` log (every command run in a Terminal session, with its cwd — see shell integration), not shell-history files. `recentCommands`/`frequentCommands` in `db.ts` rank distinct commands with the requested cwd preferred (same-cwd first, then global). Still filtered per-cwd in `listCommands`: only relative-path invocations (`./x`) are cwd-dependent and dropped if absent from the folder; plain names and absolute paths always kept. Ranked pool is larger than shown so the filter can still fill `HISTORY_LIMIT`. Cold-start: empty until commands are run through a Terminal session.
- **Shell integration / session events:** the `terminal` adapter (`adapters/shell.ts`) detects zsh/bash from the configured command and injects a startup script (zsh via hijacked `ZDOTDIR`+`USER_ZDOTDIR` → `shell-integration/zdotdir/`; bash via `--rcfile shell-integration/bash-rc.sh`) that still sources the user's own rc, then emits VS Code **OSC 633** markers (`E`=command line, `C`=exec, `D;code`=done, `P;Cwd=`=cwd). The adapter's `createEventParser()` strips those markers from the PTY stream and yields `SessionEvent`s; `manager.ts` updates `SessionInfo.cwd` live and fans events to listeners (`onEvent`). Other harnesses (claude/pi) and non-zsh/bash shells get no parser — they stream raw, unchanged. Adding event support to a harness = give its adapter a `createEventParser`; keep the OSC knowledge in the adapter. Command logging lives in a single server-global `manager.subscribe` in `index.ts` (NOT the per-connection one, or every browser double-records).
- **Dynamic arg resolvers:** a catalog `ArgNode.source` names a server-side resolver (`RESOLVERS` in `commands.ts`) that runs a *fixed* command and returns live suggestions (e.g. `docker logs` → container names from `docker ps -a`; `git checkout` → branches; `npm run` → package.json scripts). Client calls `GET /api/resolve?id=&cwd=` with only the resolver **id** (never a command) — auth'd + folder-allowlisted; results cached 3s; failures degrade to free-text. Add a resolver = add an entry to `RESOLVERS` + set `source` on the catalog node.
- **Mobile keyboard:** `App.tsx` sizes `.app` to `visualViewport.height` when the keyboard is up and floats the key-bar above it; `index.html` sets `interactive-widget=resizes-content`. Together these stop the page being panned under the keyboard — don't revert without re-checking that.

## What this is

- Harness-agnostic web remote for AI coding agents.
- Single webpage to manage local agent sessions: Claude Code + pi first, other CLI harnesses later.
- User-facing overview: `README.md`.

## Architecture (settled)

- **Frontend:** React + Vite. Renders sessions, streams output, sends input back.
- **Backend:** Node. Spawns each agent as a **local subprocess in a PTY** (`node-pty`), supervises lifecycle, streams raw terminal I/O to the browser via WebSocket.
- **Terminal:** browser renders sessions with **xterm.js**; keystrokes/resize go back over `/ws`. One persistent xterm per session (hidden when inactive) so scrollback survives tab switches.
- **Single port:** UI, `/api`, and `/ws` all listen on one port (default 4000). Dev embeds Vite in **middleware mode** in the Node server (`--dev` flag, not env); prod serves `dist/web`. `/ws` and Vite HMR coexist via `noServer` + manual `upgrade` routing.
- **Harness adapters:** core abstraction. An adapter only describes *how to invoke* an agent (`HarnessInvocation`: command/args/env); all PTY/streaming/lifecycle is harness-agnostic in `sessions/manager.ts`.
- **Hard constraint:** keep harness-specific logic confined to adapters. UI/session-mgmt/LLM features stay harness-agnostic. New agent = new adapter, never UI/core changes. Leakage into shared code = design smell.

## Config

- No env variables. All config lives in `config.json` (gitignored).
- `config-gen.sh` runs a setup dialog to generate `config.json`.
- Never reintroduce `process.env`-style config or `.env` files.

## Planned LLM features (not built)

- Layered on the harness-agnostic core; consume the common session interface; must not depend on a specific harness.
- Session summaries, natural-language task routing, notification/triage.

## Positioning

- Open-source; README onboards external contributors.
- Contributor extension path: write new harness adapters.
