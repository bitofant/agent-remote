import { describe, it, expect } from "vitest";
import { mediaKindFor, mediaTypeFor } from "./media.js";

describe("mediaKindFor", () => {
  it("recognizes images and videos", () => {
    expect(mediaKindFor("a/photo.jpg")).toBe("image");
    expect(mediaKindFor("photo.jpeg")).toBe("image");
    expect(mediaKindFor("shot.png")).toBe("image");
    expect(mediaKindFor("loop.gif")).toBe("image");
    expect(mediaKindFor("pic.webp")).toBe("image");
    expect(mediaKindFor("pic.avif")).toBe("image");
    expect(mediaKindFor("old.bmp")).toBe("image");
    expect(mediaKindFor("clip.mp4")).toBe("video");
    expect(mediaKindFor("clip.m4v")).toBe("video");
    expect(mediaKindFor("clip.webm")).toBe("video");
    expect(mediaKindFor("clip.mov")).toBe("video");
  });

  it("is case-insensitive", () => {
    expect(mediaKindFor("PHOTO.JPG")).toBe("image");
    expect(mediaKindFor("Clip.MP4")).toBe("video");
  });

  it("leaves everything else to the text editor", () => {
    expect(mediaKindFor("notes.txt")).toBeNull();
    expect(mediaKindFor("bundle.zip")).toBeNull();
    expect(mediaKindFor("page.html")).toBeNull();
    // SVG is text and stays editable in CodeMirror.
    expect(mediaKindFor("icon.svg")).toBeNull();
    expect(mediaKindFor("README")).toBeNull();
    expect(mediaKindFor(".gitignore")).toBeNull();
    expect(mediaKindFor("")).toBeNull();
  });

  it("takes the extension from the last path segment", () => {
    expect(mediaKindFor("dir.png/notes")).toBeNull();
    expect(mediaKindFor("dir.txt/photo.png")).toBe("image");
  });
});

describe("mediaTypeFor", () => {
  it("maps to a servable mime", () => {
    expect(mediaTypeFor("a.jpg")).toBe("image/jpeg");
    expect(mediaTypeFor("a.png")).toBe("image/png");
    // x-m4v is Safari-only.
    expect(mediaTypeFor("a.m4v")).toBe("video/mp4");
    expect(mediaTypeFor("a.mov")).toBe("video/quicktime");
    expect(mediaTypeFor("a.txt")).toBeNull();
  });

  // Anti-drift: the client previews exactly what the server will serve.
  it("agrees with mediaKindFor on membership", () => {
    for (const ext of ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "mp4", "m4v", "webm", "mov", "txt", "svg", "zip"]) {
      expect(mediaTypeFor(`x.${ext}`) === null).toBe(mediaKindFor(`x.${ext}`) === null);
    }
  });
});
