import { invalid } from "./errors.js";

export const TASK_PREFIX = "T";

export function taskKey(id: number): string {
  return `${TASK_PREFIX}-${id}`;
}

/** Accepts "T-42", "t-42", "#42", "42" → 42. */
export function parseTaskKey(input: string | number): number {
  if (typeof input === "number") {
    if (Number.isInteger(input) && input > 0) return input;
    throw invalid(`Invalid task id: ${input}`);
  }
  const m = /^\s*(?:#|[tT]-?)?(\d+)\s*$/.exec(input);
  const n = m ? Number(m[1]) : 0;
  if (!m || n < 1) {
    throw invalid(`Invalid task id "${input}"`, `Use the form "${TASK_PREFIX}-42" (or just "42").`);
  }
  return n;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** Accepts "@petya" or "petya" → "petya". Throws if not a valid handle. */
export function normalizeHandle(input: string): string {
  const h = input.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE_RE.test(h)) {
    throw invalid(
      `Invalid handle "${input}"`,
      "Handles are 2-32 chars: lowercase letters, digits, '_' or '-', starting with a letter or digit.",
    );
  }
  return h;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addMinutesIso(minutes: number, from: Date = new Date()): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}
