/**
 * Token handling. Tokens are random, shown once, and stored only as SHA-256 hashes.
 * Identity is never self-declared by the caller: it is derived from the token alone.
 */
import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "ember_";

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Extracts a bearer token from an Authorization header value. */
export function bearerFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}
