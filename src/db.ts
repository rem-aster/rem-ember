/**
 * SQLite storage on top of the built-in `node:sqlite` module (Node >= 22.13, no native deps).
 * Everything is synchronous; the tracker's data volume is small and the process is single-threaded.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastId: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  /** Runs `fn` inside a transaction; nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.inTx = true;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  close(): void {
    this.raw.close();
  }

  private inTx = false;

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS actors (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        handle        TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('human','agent','bot')),
        role          TEXT NOT NULL CHECK (role IN ('admin','manager','developer','reporter')),
        owner_id      INTEGER REFERENCES actors(id) ON DELETE SET NULL,
        context       TEXT,
        token_hash    TEXT UNIQUE,
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        last_seen_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        title            TEXT NOT NULL,
        status           TEXT NOT NULL CHECK (status IN ('inbox','analysis','ready','in_progress','review','done','dropped')),
        priority         TEXT NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
        kind             TEXT NOT NULL CHECK (kind IN ('bug','feature','chore','question','other')),
        raw              TEXT NOT NULL,
        problem          TEXT,
        analysis         TEXT,
        acceptance       TEXT,
        labels           TEXT NOT NULL DEFAULT '[]',
        refs             TEXT NOT NULL DEFAULT '[]',
        source_channel   TEXT NOT NULL,
        source_ref       TEXT UNIQUE,
        source_author    TEXT,
        reporter_id      INTEGER NOT NULL REFERENCES actors(id),
        analyst_id       INTEGER REFERENCES actors(id),
        assignee_id      INTEGER REFERENCES actors(id),
        claim_actor_id   INTEGER REFERENCES actors(id),
        claim_purpose    TEXT CHECK (claim_purpose IN ('analysis','implementation','review')),
        claim_note       TEXT,
        claim_at         TEXT,
        claim_expires_at TEXT,
        blocked_by       TEXT NOT NULL DEFAULT '[]',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        done_at          TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, priority, created_at);
      CREATE INDEX IF NOT EXISTS tasks_claim_idx ON tasks(claim_expires_at) WHERE claim_actor_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks(assignee_id);
      CREATE INDEX IF NOT EXISTS tasks_updated_idx ON tasks(updated_at);

      CREATE TABLE IF NOT EXISTS comments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_id     INTEGER NOT NULL REFERENCES actors(id),
        kind         TEXT NOT NULL CHECK (kind IN ('comment','question','answer','decision')),
        body         TEXT NOT NULL,
        to_actor_id  INTEGER REFERENCES actors(id),
        to_role      TEXT CHECK (to_role IN ('admin','manager','developer','reporter')),
        reply_to     INTEGER REFERENCES comments(id),
        resolved_at  TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS comments_task_idx ON comments(task_id, created_at);
      CREATE INDEX IF NOT EXISTS comments_open_q_idx ON comments(kind, resolved_at) WHERE kind = 'question';

      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        actor_id   INTEGER NOT NULL REFERENCES actors(id),
        type       TEXT NOT NULL,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at);
      CREATE INDEX IF NOT EXISTS events_task_idx ON events(task_id, created_at);

      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
    `);
  }
}

export function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
