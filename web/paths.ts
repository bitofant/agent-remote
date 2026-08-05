// Display-only path formatting. Stored paths stay absolute (they're folder
// identities — see server/paths.ts); this is purely what the user reads.

const trimSlashes = (path: string) => path.replace(/\/+$/, "");

/** `/home/me/src/x/` → `~/src/x/`, given the server's $HOME. Leaves anything
 * outside home alone, and never matches a partial segment (`/home/mees`).
 * Home *itself* stays absolute: a lone `~/` names nothing useful. */
export function displayPath(path: string, home: string): string {
  if (!home) return path;
  const root = trimSlashes(home);
  if (!path.startsWith(root)) return path;
  const rest = path.slice(root.length);
  if (rest === "" || rest === "/") return path;
  return rest.startsWith("/") ? `~${rest}` : path;
}

/** Last path segment, for the folder list's bold label. Home itself is "home",
 * not the account name — `joran` reads like just another project folder. */
export function folderName(path: string, home = ""): string {
  if (home && trimSlashes(path) === trimSlashes(home)) return "home";
  return path.split("/").filter(Boolean).pop() ?? path;
}
