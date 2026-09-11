import type { Status } from "./types.js";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** Extra Host header values accepted when not bound to localhost (DNS rebinding protection). */
  allowedHosts: string[];
  maxClaimsPerActor: number;
  defaultClaimTtlMinutes: number;
  maxClaimTtlMinutes: number;
  /** Optional per-status WIP limits, e.g. { in_progress: 5 }. */
  wipLimits: Partial<Record<Status, number>>;
  bodyLimitBytes: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parses "in_progress=5,analysis=3" into a partial status → limit map. */
export function parseWipLimits(raw: string | undefined): Partial<Record<Status, number>> {
  const out: Partial<Record<Status, number>> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (!k) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`EMBER_WIP_LIMITS: bad entry "${pair}" (expected status=positive integer)`);
    }
    out[k as Status] = n;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.EMBER_HOST ?? "127.0.0.1",
    port: intEnv("EMBER_PORT", 8787),
    dbPath: env.EMBER_DB_PATH ?? "./data/ember.db",
    allowedHosts: listEnv("EMBER_ALLOWED_HOSTS"),
    maxClaimsPerActor: intEnv("EMBER_MAX_CLAIMS_PER_ACTOR", 3),
    defaultClaimTtlMinutes: intEnv("EMBER_CLAIM_TTL_MINUTES", 90),
    maxClaimTtlMinutes: intEnv("EMBER_MAX_CLAIM_TTL_MINUTES", 24 * 60),
    wipLimits: parseWipLimits(env.EMBER_WIP_LIMITS),
    bodyLimitBytes: intEnv("EMBER_BODY_LIMIT_BYTES", 1_048_576),
  };
}
