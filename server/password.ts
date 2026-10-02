import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Async scrypt: the sync form blocks the event loop (~50ms/hash), which hosts
// every live session — a login flood would stall them all.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEY_LEN = 64;

/** Hash a password as `salt:derivedKeyHex`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, KEY_LEN);
  return `${salt}:${derived.toString("hex")}`;
}

// Verified against for unknown users so their timing matches a real mismatch.
const DUMMY_HASH = `${randomBytes(16).toString("hex")}:${"00".repeat(KEY_LEN)}`;

/** Constant-time check of a password against a stored `salt:hash`. A missing
 * `stored` still pays a full scrypt (no username enumeration by timing). */
export async function verifyPassword(
  password: string,
  stored: string | undefined,
): Promise<boolean> {
  const [salt, hash] = (stored ?? DUMMY_HASH).split(":");
  if (!salt || !hash) return false;
  const derived = await scryptAsync(password, salt, KEY_LEN);
  const expected = Buffer.from(hash, "hex");
  const ok =
    derived.length === expected.length && timingSafeEqual(derived, expected);
  return ok && stored !== undefined;
}
