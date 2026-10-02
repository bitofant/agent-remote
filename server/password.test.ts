import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("round-trips and rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse");
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await verifyPassword("correct horse", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("salts: same password, different hashes", async () => {
    expect(await hashPassword("x")).not.toBe(await hashPassword("x"));
  });

  it("an unknown user (no stored hash) never verifies", async () => {
    expect(await verifyPassword("anything", undefined)).toBe(false);
  });

  it("rejects a malformed stored hash", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});
