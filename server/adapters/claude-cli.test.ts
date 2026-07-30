import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalCli } from "./claude.js";

// resolveLocalCli picks the on-$PATH `claude` so the SDK drives it instead of
// its (potentially stale) bundled binary. Tests use a throwaway dir on PATH.
describe("resolveLocalCli", () => {
  let dir: string;
  const savedPath = process.env.PATH;

  const makeExecutable = (name: string): string => {
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-cli-"));
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a bare command name on $PATH", () => {
    const p = makeExecutable("claude");
    process.env.PATH = dir;
    expect(resolveLocalCli("claude")).toBe(p);
  });

  it("returns undefined when the command is not on $PATH", () => {
    process.env.PATH = dir; // empty dir
    expect(resolveLocalCli("claude")).toBeUndefined();
  });

  it("returns undefined for a non-executable file on $PATH", () => {
    const p = join(dir, "claude");
    writeFileSync(p, "not executable");
    chmodSync(p, 0o644);
    process.env.PATH = dir;
    expect(resolveLocalCli("claude")).toBeUndefined();
  });

  it("resolves an explicit absolute path", () => {
    const p = makeExecutable("claude");
    process.env.PATH = "/nonexistent"; // ignored for explicit paths
    expect(resolveLocalCli(p)).toBe(p);
  });

  it("rejects node-script paths (SDK wants a native binary here)", () => {
    const p = join(dir, "cli.js");
    writeFileSync(p, "#!/usr/bin/env node\n");
    chmodSync(p, 0o755);
    expect(resolveLocalCli(p)).toBeUndefined();
  });

  it("takes the first match across $PATH entries", () => {
    const first = mkdtempSync(join(tmpdir(), "claude-cli-a-"));
    try {
      const p1 = join(first, "claude");
      writeFileSync(p1, "#!/bin/sh\n");
      chmodSync(p1, 0o755);
      makeExecutable("claude"); // second dir also has one
      process.env.PATH = `${first}:${dir}`;
      expect(resolveLocalCli("claude")).toBe(p1);
    } finally {
      rmSync(first, { recursive: true, force: true });
    }
  });
});
