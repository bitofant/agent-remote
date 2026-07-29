import { describe, it, expect } from "vitest";
import { buildUserContent } from "./claude.js";
import { piImages } from "./pi.js";
import type { ChatImageRef } from "../../shared/protocol.js";

const img = (over: Partial<ChatImageRef> = {}): ChatImageRef => ({
  id: "a",
  mediaType: "image/png",
  data: "QUJD", // base64 "ABC"
  ...over,
});

describe("claude buildUserContent", () => {
  it("returns a bare string when there are no images", () => {
    expect(buildUserContent("hello")).toBe("hello");
  });

  it("builds text + base64 image content blocks", () => {
    const content = buildUserContent("look", [img()]);
    expect(content).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      },
    ]);
  });

  it("omits the text block for an image-only prompt", () => {
    const content = buildUserContent("", [img({ mediaType: "image/jpeg" })]);
    expect(content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
      },
    ]);
  });

  it("skips images the server never resolved (no data) and falls back to text", () => {
    const content = buildUserContent("hi", [img({ data: undefined })]);
    expect(content).toBe("hi");
  });
});

describe("pi piImages", () => {
  it("maps refs to pi ImageContent blocks", () => {
    expect(piImages([img()])).toEqual([
      { type: "image", data: "QUJD", mimeType: "image/png" },
    ]);
  });

  it("returns [] for no images and skips unresolved refs", () => {
    expect(piImages()).toEqual([]);
    expect(piImages([img({ data: undefined })])).toEqual([]);
  });
});
