// Previewable media allowlist, shared so the client's "should I preview this?"
// and the server's content-type can never disagree. Deliberately excludes .svg:
// it's text and stays editable in CodeMirror.

export type MediaKind = "image" | "video";

const MEDIA_TYPES: Record<string, { kind: MediaKind; mime: string }> = {
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  png: { kind: "image", mime: "image/png" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  avif: { kind: "image", mime: "image/avif" },
  bmp: { kind: "image", mime: "image/bmp" },
  mp4: { kind: "video", mime: "video/mp4" },
  // video/x-m4v is Safari-only; mp4 plays everywhere.
  m4v: { kind: "video", mime: "video/mp4" },
  webm: { kind: "video", mime: "video/webm" },
  mov: { kind: "video", mime: "video/quicktime" },
};

// Extension of the last path segment ("dir.png/notes" has none), lowercased.
// A leading dot is the whole name (".gitignore"), not an extension.
function extOf(path: string): string {
  const name = path.split("/").filter(Boolean).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** "image" | "video" for a previewable extension, else null. */
export function mediaKindFor(path: string): MediaKind | null {
  return MEDIA_TYPES[extOf(path)]?.kind ?? null;
}

/** MIME for a previewable extension, else null — the /api/media allowlist. */
export function mediaTypeFor(path: string): string | null {
  return MEDIA_TYPES[extOf(path)]?.mime ?? null;
}
