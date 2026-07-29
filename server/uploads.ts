// Storage for user-uploaded images attached to chat prompts. Bytes live on disk
// under data/uploads/; ownership lives in the SQLite `uploads` table (db.ts).
// Every read is ownership-checked here so a stored image can only be served or
// sent to an agent by the user who uploaded it. Kept deliberately narrow — this
// is NOT a general file store.

import { mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { deleteUpload, getUpload, insertUpload, staleUploadIds } from "./db.js";

/** Image media types both harnesses (and the Anthropic API) accept. */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** Refuse anything larger than this per image. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const UPLOADS_DIR = resolve(process.cwd(), "data/uploads");
mkdirSync(UPLOADS_DIR, { recursive: true });

export function isAllowedImageType(mediaType: string): boolean {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(mediaType);
}

/** Resolve an upload id to its on-disk path, guaranteeing it stays inside the
 * uploads dir (defense-in-depth — ids are random UUIDs, never user paths). */
function fileFor(id: string): string {
  if (id.includes("\0") || id.includes("/") || id.includes(sep) || id.includes("..")) {
    throw new Error("Invalid upload id.");
  }
  const target = resolve(UPLOADS_DIR, id);
  const rootWithSep = UPLOADS_DIR.endsWith(sep) ? UPLOADS_DIR : UPLOADS_DIR + sep;
  if (!target.startsWith(rootWithSep)) throw new Error("Invalid upload id.");
  return target;
}

/** Persist an uploaded image and record its owner. Validates media type and
 * size. Returns the new opaque id. */
export async function saveUpload(
  owner: string,
  mediaType: string,
  name: string | undefined,
  buf: Buffer,
): Promise<string> {
  if (!isAllowedImageType(mediaType)) throw new Error("Unsupported image type.");
  if (buf.length === 0) throw new Error("Empty image.");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("Image is too large.");
  const id = randomUUID();
  await writeFile(fileFor(id), buf);
  insertUpload({ id, owner, mediaType, name: name ?? null, bytes: buf.length });
  if (Math.random() < 0.05) void prune();
  return id;
}

/** Load an image's bytes, but only if it belongs to `owner`. Returns null for a
 * missing id, a foreign owner, or a missing file. */
export async function loadUpload(
  owner: string,
  id: string,
): Promise<{ mediaType: string; name: string | null; buf: Buffer } | null> {
  const row = getUpload(id);
  if (!row || row.owner !== owner) return null;
  try {
    const buf = await readFile(fileFor(id));
    return { mediaType: row.mediaType, name: row.name, buf };
  } catch {
    return null;
  }
}

/** Delete upload rows (and files) beyond the retention cap. Best-effort. */
export async function prune(): Promise<void> {
  for (const id of staleUploadIds()) {
    try {
      await unlink(fileFor(id));
    } catch {
      // File already gone — still drop the row.
    }
    deleteUpload(id);
  }
}
