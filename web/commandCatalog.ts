// Static knowledge about well-known commands, used by the command builder to
// suggest subcommands/flags after a command is chosen. This is pure reference
// data (not filesystem-derived), so it lives client-side. Unknown commands fall
// back to free-text args.

/** A suggestable argument token. `children` are the static suggestions offered
 * after this token is added (e.g. `docker ps` → `-a`). `source` names a
 * server-side resolver whose live results are offered too (e.g. `docker logs` →
 * running container names); see `RESOLVERS` in `server/commands.ts`. */
export interface ArgNode {
  value: string;
  detail?: string;
  children?: ArgNode[];
  source?: string;
}

export interface CommandSpec {
  detail?: string;
  args: ArgNode[];
}

export const COMMAND_CATALOG: Record<string, CommandSpec> = {
  docker: {
    detail: "container engine",
    args: [
      {
        value: "ps",
        detail: "list containers",
        children: [
          { value: "-a", detail: "include stopped" },
          { value: "-q", detail: "ids only" },
        ],
      },
      { value: "images", detail: "list images" },
      { value: "start", detail: "start a container", source: "docker-containers" },
      { value: "stop", detail: "stop a container", source: "docker-running" },
      { value: "restart", detail: "restart a container", source: "docker-containers" },
      { value: "rm", detail: "remove a container", source: "docker-containers" },
      { value: "rmi", detail: "remove an image", source: "docker-images" },
      { value: "pull", detail: "download an image" },
      { value: "push", detail: "upload an image" },
      { value: "build", detail: "build an image", children: [{ value: "-t", detail: "tag" }] },
      { value: "run", detail: "run a new container", source: "docker-images", children: [
        { value: "-it", detail: "interactive tty" },
        { value: "-d", detail: "detached" },
        { value: "--rm", detail: "remove on exit" },
      ] },
      { value: "exec", detail: "run in a container", source: "docker-running", children: [{ value: "-it", detail: "interactive tty" }] },
      { value: "logs", detail: "fetch logs", source: "docker-containers", children: [{ value: "-f", detail: "follow" }] },
    ],
  },
  git: {
    detail: "version control",
    args: [
      { value: "status", detail: "working tree status" },
      { value: "add", detail: "stage changes", children: [{ value: "-A", detail: "all" }, { value: "-p", detail: "patch" }] },
      { value: "commit", detail: "record changes", children: [
        { value: "-m", detail: "message" },
        { value: "-a", detail: "stage tracked" },
        { value: "--amend", detail: "amend last" },
      ] },
      { value: "push", detail: "update remote", source: "git-remotes" },
      { value: "pull", detail: "fetch + merge", source: "git-remotes" },
      { value: "fetch", detail: "download objects", source: "git-remotes" },
      { value: "checkout", detail: "switch branch", source: "git-branches", children: [{ value: "-b", detail: "new branch" }] },
      { value: "switch", detail: "switch branch", source: "git-branches", children: [{ value: "-c", detail: "new branch" }] },
      { value: "branch", detail: "list/manage branches" },
      { value: "merge", detail: "join histories", source: "git-branches" },
      { value: "rebase", detail: "replay commits", source: "git-branches" },
      { value: "log", detail: "show history", children: [
        { value: "--oneline", detail: "compact" },
        { value: "--graph", detail: "graph" },
      ] },
      { value: "diff", detail: "show changes", children: [{ value: "--staged", detail: "staged" }] },
      { value: "stash", detail: "shelve changes" },
      { value: "clone", detail: "copy a repo" },
      { value: "reset", detail: "reset state", children: [{ value: "--hard", detail: "discard" }] },
    ],
  },
  npm: {
    detail: "node package manager",
    args: [
      { value: "install", detail: "install deps", children: [
        { value: "-D", detail: "dev dependency" },
        { value: "-g", detail: "global" },
      ] },
      { value: "run", detail: "run a script", source: "npm-scripts" },
      { value: "start", detail: "run start script" },
      { value: "test", detail: "run tests" },
      { value: "ci", detail: "clean install" },
      { value: "update", detail: "update packages" },
      { value: "uninstall", detail: "remove a package" },
      { value: "publish", detail: "publish a package" },
      { value: "ls", detail: "list installed" },
    ],
  },
  kubectl: {
    detail: "kubernetes cli",
    args: [
      { value: "get", detail: "list resources", children: [
        { value: "pods", detail: "pods" },
        { value: "svc", detail: "services" },
        { value: "deployments", detail: "deployments" },
        { value: "nodes", detail: "nodes" },
      ] },
      { value: "describe", detail: "show details" },
      { value: "apply", detail: "apply config", children: [{ value: "-f", detail: "file" }] },
      { value: "delete", detail: "delete resources" },
      { value: "logs", detail: "container logs", children: [{ value: "-f", detail: "follow" }] },
      { value: "exec", detail: "run in a pod", children: [{ value: "-it", detail: "interactive tty" }] },
    ],
  },
  systemctl: {
    detail: "service manager",
    args: [
      { value: "status", detail: "service status" },
      { value: "start", detail: "start a unit" },
      { value: "stop", detail: "stop a unit" },
      { value: "restart", detail: "restart a unit" },
      { value: "enable", detail: "enable on boot" },
      { value: "disable", detail: "disable on boot" },
      { value: "--user", detail: "user manager" },
    ],
  },
  make: {
    detail: "build tool",
    args: [
      { value: "build", detail: "common target" },
      { value: "test", detail: "common target" },
      { value: "clean", detail: "common target" },
      { value: "install", detail: "common target" },
      { value: "-j", detail: "parallel jobs" },
    ],
  },
};

// Curated common commands (including shell builtins) shown above the full $PATH
// scan in the command picker. Keep this short and genuinely common.
export const COMMON_COMMANDS: string[] = [
  "cd", "ls", "pwd", "echo", "cat", "man", "clear", "history",
  "grep", "find", "sed", "awk", "sort", "uniq", "wc", "head", "tail", "less",
  "cp", "mv", "rm", "mkdir", "touch", "chmod", "chown", "ln", "which",
  "ps", "kill", "df", "du", "top", "export", "source", "tar", "unzip",
  "ssh", "scp", "curl", "wget", "ping",
  "git", "docker", "docker-compose", "kubectl", "systemctl", "make",
  "npm", "npx", "yarn", "pnpm", "node", "python3", "pip",
];
