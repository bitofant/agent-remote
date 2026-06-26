import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { recentCommands, frequentCommands } from "./db.js";
import type {
  CommandArgSuggestion,
  CommandListing,
  CommandResolveResult,
} from "../shared/protocol.js";

const execFileAsync = promisify(execFile);

// $PATH and aliases don't depend on the requested cwd and are mildly expensive
// (a directory scan / spawning a shell), so cache them across requests. Only
// the per-folder local executables are recomputed every time.
const TTL_MS = 30_000;
let pathCache: { at: number; value: string[] } | undefined;
let aliasCache: { at: number; value: CommandListing["aliases"] } | undefined;

// How many entries to surface in each of the recent / frequent sections.
const HISTORY_LIMIT = 8;
// Rank a larger pool than we show, so the per-cwd availability filter still has
// enough candidates left to fill HISTORY_LIMIT.
const HISTORY_POOL = 60;

/** True if a directory entry should be offered as a runnable command: a regular
 * file that is either executable or a shell script. */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return false;
    return (s.mode & 0o111) !== 0 || path.endsWith(".sh");
  } catch {
    return false; // dangling symlink, race with deletion, permission, …
  }
}

async function listLocal(cwd: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(cwd);
  } catch {
    return [];
  }
  const checks = await Promise.all(
    entries.map(async (name) =>
      (await isExecutableFile(join(cwd, name))) ? name : undefined,
    ),
  );
  return checks.filter((n): n is string => n !== undefined).sort();
}

async function listPath(): Promise<string[]> {
  if (pathCache && Date.now() - pathCache.at < TTL_MS) return pathCache.value;
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const names = new Set<string>();
  await Promise.all(
    dirs.map(async (dir) => {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return; // missing/!readable PATH entry — skip
      }
      const checks = await Promise.all(
        entries.map(async (name) =>
          (await isExecutableFile(join(dir, name))) ? name : undefined,
        ),
      );
      for (const n of checks) if (n) names.add(n);
    }),
  );
  const value = [...names].sort();
  pathCache = { at: Date.now(), value };
  return value;
}

// Parse the output of the shell `alias` builtin. zsh prints `name=value`, bash
// prints `alias name='value'`; tolerate both and the optional quoting.
function parseAliases(out: string): CommandListing["aliases"] {
  const result: CommandListing["aliases"] = [];
  for (const raw of out.split("\n")) {
    const line = raw.replace(/^alias\s+/, "").trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[\w.-]+$/.test(name)) result.push({ name, value });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function listAliases(): Promise<CommandListing["aliases"]> {
  if (aliasCache && Date.now() - aliasCache.at < TTL_MS) return aliasCache.value;
  const shell = process.env.SHELL || "/bin/bash";
  let value: CommandListing["aliases"] = [];
  try {
    // -i so the interactive rc (where aliases live) is sourced. Guard with a
    // timeout: a misbehaving rc must not hang the request.
    const { stdout } = await execFileAsync(shell, ["-ic", "alias"], {
      timeout: 2000,
      maxBuffer: 1 << 20,
    });
    value = parseAliases(stdout);
  } catch {
    value = []; // shell missing, rc errored, or timed out — degrade to none
  }
  aliasCache = { at: Date.now(), value };
  return value;
}

// Whether a recorded command line could actually run in `cwd`. Only relative
// path invocations (`./restart.sh`, `../tool`) are cwd-dependent — plain names
// resolve via PATH/aliases/builtins and absolute paths don't depend on cwd, so
// those are always kept. A `./name` is checked against the cwd's executables;
// deeper relative paths are stat'd directly.
async function availableInCwd(
  line: string,
  cwd: string,
  local: Set<string>,
): Promise<boolean> {
  const token = line.split(/\s+/)[0] ?? "";
  if (!/^\.\.?\//.test(token)) return true;
  const simple = /^\.\/([^/]+)$/.exec(token);
  if (simple) return local.has(simple[1]);
  return isExecutableFile(join(cwd, token));
}

export async function listCommands(cwd: string): Promise<CommandListing> {
  const [local, path, aliases] = await Promise.all([
    listLocal(cwd),
    listPath(),
    listAliases(),
  ]);
  // Recent/frequent come from the recorded command log (commands run through
  // shell sessions), ranked with the requested cwd preferred. A pool larger than
  // we show is fetched so the availability filter can still fill HISTORY_LIMIT.
  const localSet = new Set(local);
  const filterAvailable = async (cmds: string[]) => {
    const ok = await Promise.all(
      cmds.map((c) => availableInCwd(c, cwd, localSet)),
    );
    return cmds.filter((_, i) => ok[i]).slice(0, HISTORY_LIMIT);
  };
  const [recent, frequent] = await Promise.all([
    filterAvailable(recentCommands(cwd, HISTORY_POOL)),
    filterAvailable(frequentCommands(cwd, HISTORY_POOL)),
  ]);
  return { local, path, aliases, recent, frequent };
}

// --- dynamic argument resolvers --------------------------------------------
// A resolver produces live suggestions for a command argument (e.g. container
// names for `docker logs`). The catalog references these by id; the actual
// command is fixed here, never supplied by the client — the browser only ever
// sends a resolver id, so this can't be used to run arbitrary commands.

type Resolver = (cwd: string) => Promise<CommandArgSuggestion[]>;

// One suggestion per output line; a tab splits value from detail.
function byLine(out: string): CommandArgSuggestion[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab === -1
        ? { value: line }
        : { value: line.slice(0, tab), detail: line.slice(tab + 1).trim() };
    });
}

// Build a resolver that runs a fixed command in the cwd and parses its stdout.
function fromCommand(
  command: string,
  args: string[],
  parse: (out: string) => CommandArgSuggestion[] = byLine,
): Resolver {
  return async (cwd) => {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: 4000,
      maxBuffer: 1 << 20,
    });
    return parse(stdout);
  };
}

const RESOLVERS: Record<string, Resolver> = {
  "docker-containers": fromCommand("docker", [
    "ps", "-a", "--format", "{{.Names}}\t{{.Status}}",
  ]),
  "docker-running": fromCommand("docker", [
    "ps", "--format", "{{.Names}}\t{{.Status}}",
  ]),
  "docker-images": fromCommand("docker", [
    "images", "--format", "{{.Repository}}:{{.Tag}}\t{{.Size}}",
  ]),
  "git-branches": fromCommand("git", ["branch", "--format", "%(refname:short)"]),
  "git-remotes": fromCommand("git", ["remote"]),
  "npm-scripts": async (cwd) => {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    const scripts: Record<string, string> = pkg.scripts ?? {};
    return Object.entries(scripts).map(([value, detail]) => ({ value, detail }));
  },
};

export const RESOLVER_IDS = new Set(Object.keys(RESOLVERS));

// Short cache so the dialog (and React effect double-invokes) don't re-run the
// same probe repeatedly; live data like container lists still refreshes fast.
const RESOLVE_TTL_MS = 3000;
const resolveCache = new Map<string, { at: number; value: CommandResolveResult }>();

export async function resolveCommand(
  id: string,
  cwd: string,
): Promise<CommandResolveResult> {
  const key = `${id}\0${cwd}`;
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;

  const resolver = RESOLVERS[id];
  let value: CommandResolveResult;
  try {
    value = { suggestions: await resolver(cwd) };
  } catch (err) {
    // Command missing, non-zero exit (daemon down, not a repo, …), or no
    // package.json — degrade to free-text rather than failing the request.
    value = { suggestions: [], error: (err as Error).message.split("\n")[0] };
  }
  resolveCache.set(key, { at: Date.now(), value });
  return value;
}
