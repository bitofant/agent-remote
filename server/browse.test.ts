import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browseDirs } from "./browse.js";

// Real fs, but only a throwaway tmp tree — no processes, no network.
describe("browseDirs", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "browse-test-"));
    await mkdir(join(root, "beta"));
    await mkdir(join(root, "Alpha"));
    await writeFile(join(root, "notes.txt"), "x");
    await symlink(join(root, "beta"), join(root, "link-to-beta"));
    await symlink(join(root, "notes.txt"), join(root, "link-to-file"));
    await symlink(join(root, "gone"), join(root, "broken"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("returns only directories, case-insensitively sorted", async () => {
    const listing = await browseDirs(root);
    expect(listing.entries.map((e) => e.name)).toEqual([
      "Alpha",
      "beta",
      "link-to-beta", // symlinked dirs are browsable
    ]);
  });

  it("returns canonical absolute paths for itself, its parent and its entries", async () => {
    const listing = await browseDirs(root);
    expect(listing.path).toBe(`${root}/`);
    expect(listing.parent).toBe(`${tmpdir().replace(/\/+$/, "")}/`);
    expect(listing.entries[0].path).toBe(`${root}/Alpha/`);
  });

  it("stops at the filesystem root", async () => {
    expect((await browseDirs("/")).parent).toBe(null);
  });

  it("reports missing/non-directory paths readably", async () => {
    await expect(browseDirs(join(root, "gone"))).rejects.toThrow("No such folder.");
    await expect(browseDirs(join(root, "notes.txt"))).rejects.toThrow("Not a folder.");
  });
});
