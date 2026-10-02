// npm run add-user [-- <username>]
// Creates an account (or resets its password) AND enables it in config.json in
// one step — the safe path while web registration is closed. The running server
// picks the change up without a restart (config users are live-reloaded).
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { configPath } from "../server/config.js";
import { createUser, getUser, setUserPassword } from "../server/db.js";
import { hashPassword } from "../server/password.js";

const MAX_FIELD_LEN = 256; // matches server/auth.ts

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) {
    // Echo the prompt, swallow the typed characters.
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    out._writeToOutput = (s: string) => {
      if (s.startsWith(question)) process.stdout.write(question);
      else if (s.includes("\n")) process.stdout.write("\n");
    };
  }
  return new Promise((resolve) => {
    let answered = false;
    rl.on("close", () => answered || fail("\nAborted."));
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  const username = (process.argv[2] ?? (await ask("Username: "))).trim();
  if (!username) fail("Username is required.");
  if (username.length > MAX_FIELD_LEN) fail("Username too long.");

  const existing = getUser(username);
  if (existing) {
    const yes = await ask(`"${username}" exists. Reset its password? [y/N] `);
    if (!/^y/i.test(yes.trim())) fail("Aborted.");
  }

  const password = await ask("Password: ", true);
  if (!password) fail("Password is required.");
  if (password.length > MAX_FIELD_LEN) fail("Password too long.");
  if ((await ask("Repeat password: ", true)) !== password) {
    fail("Passwords don't match.");
  }

  const hash = await hashPassword(password);
  if (existing) {
    setUserPassword(username, hash);
    console.log(`Password reset for "${username}"; its sessions were logged out.`);
  } else {
    createUser(username, hash);
    console.log(`Created "${username}".`);
  }

  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    users?: string[];
  };
  const users = Array.isArray(config.users) ? config.users : [];
  if (users.includes(username)) {
    console.log("Already enabled in config.json.");
  } else {
    config.users = [...users, username];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log("Enabled in config.json.");
  }
}

main().catch((err) => fail(String(err)));
