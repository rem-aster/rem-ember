import type { Db, Row } from "../db.js";
import { generateToken, hashToken } from "../auth.js";
import { conflict, forbidden, invalid, notFound } from "../errors.js";
import { normalizeHandle, nowIso } from "../ids.js";
import type { Actor, ActorKind, ActorPublic, Role } from "../types.js";

const ACTOR_COLS = `a.id, a.handle, a.display_name, a.kind, a.role, a.owner_id, a.context,
  (a.token_hash IS NOT NULL) AS has_token, a.active, a.created_at, a.last_seen_at`;

function rowToActor(r: Row): Actor {
  return {
    id: Number(r.id),
    handle: String(r.handle),
    display_name: String(r.display_name),
    kind: r.kind as ActorKind,
    role: r.role as Role,
    owner_id: r.owner_id == null ? null : Number(r.owner_id),
    context: r.context == null ? null : String(r.context),
    has_token: Boolean(r.has_token),
    active: Boolean(r.active),
    created_at: String(r.created_at),
    last_seen_at: r.last_seen_at == null ? null : String(r.last_seen_at),
  };
}

export interface CreateActorInput {
  handle: string;
  display_name: string;
  kind: ActorKind;
  role: Role;
  owner?: string | null;
  context?: string | null;
  issue_token?: boolean;
}

export interface UpdateActorInput {
  display_name?: string;
  role?: Role;
  kind?: ActorKind;
  owner?: string | null;
  context?: string | null;
  active?: boolean;
}

export class ActorService {
  constructor(private readonly db: Db) {}

  count(): number {
    return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM actors")?.n ?? 0);
  }

  byId(id: number): Actor | undefined {
    const r = this.db.get(`SELECT ${ACTOR_COLS} FROM actors a WHERE a.id = ?`, id);
    return r ? rowToActor(r) : undefined;
  }

  byHandle(handle: string): Actor | undefined {
    const h = normalizeHandle(handle);
    const r = this.db.get(`SELECT ${ACTOR_COLS} FROM actors a WHERE a.handle = ?`, h);
    return r ? rowToActor(r) : undefined;
  }

  /** Like byHandle but throws a not_found error naming the handle. */
  require(handle: string): Actor {
    const a = this.byHandle(handle);
    if (!a) throw notFound(`Actor @${normalizeHandle(handle)} does not exist`, "Use ember_list_actors to see who is registered.");
    return a;
  }

  /** Resolves a bearer token to an active actor, or undefined. Updates last_seen_at. */
  authenticate(token: string): Actor | undefined {
    const r = this.db.get(
      `SELECT ${ACTOR_COLS} FROM actors a WHERE a.token_hash = ? AND a.active = 1`,
      hashToken(token),
    );
    if (!r) return undefined;
    const actor = rowToActor(r);
    this.db.run("UPDATE actors SET last_seen_at = ? WHERE id = ?", nowIso(), actor.id);
    return actor;
  }

  list(opts: { role?: Role; kind?: ActorKind; include_inactive?: boolean } = {}): Actor[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!opts.include_inactive) where.push("a.active = 1");
    if (opts.role) {
      where.push("a.role = ?");
      params.push(opts.role);
    }
    if (opts.kind) {
      where.push("a.kind = ?");
      params.push(opts.kind);
    }
    const sql = `SELECT ${ACTOR_COLS} FROM actors a ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.kind = 'human' DESC, a.handle`;
    return this.db.all(sql, ...params).map(rowToActor);
  }

  toPublic(a: Actor): ActorPublic {
    const owner = a.owner_id == null ? null : this.byId(a.owner_id)?.handle ?? null;
    return {
      id: a.id,
      handle: a.handle,
      display_name: a.display_name,
      kind: a.kind,
      role: a.role,
      owner,
      context: a.context,
      active: a.active,
      last_seen_at: a.last_seen_at,
    };
  }

  /** Creates an actor. Returns the plaintext token exactly once (or null if no token was issued). */
  create(input: CreateActorInput, by: Actor | null): { actor: Actor; token: string | null } {
    const handle = normalizeHandle(input.handle);
    if (this.byHandle(handle)) {
      throw conflict(`Handle @${handle} is already taken`, "Pick another handle or update the existing actor.");
    }
    const ownerId = this.resolveOwner(input.owner, input.kind);
    const token = input.issue_token === false ? null : generateToken();
    const now = nowIso();
    return this.db.transaction(() => {
      const { lastId } = this.db.run(
        `INSERT INTO actors(handle, display_name, kind, role, owner_id, context, token_hash, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        handle,
        input.display_name.trim(),
        input.kind,
        input.role,
        ownerId,
        input.context?.trim() || null,
        token ? hashToken(token) : null,
        now,
      );
      this.logActorEvent(by?.id ?? lastId, "actor.created", { handle, kind: input.kind, role: input.role, ...(by ? {} : { via: "cli" }) });
      const actor = this.byId(lastId)!;
      return { actor, token };
    });
  }

  update(handle: string, patch: UpdateActorInput, by: Actor | null): Actor {
    const actor = this.require(handle);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const changed: Record<string, unknown> = {};

    if (patch.display_name !== undefined) {
      sets.push("display_name = ?");
      params.push(patch.display_name.trim());
      changed.display_name = patch.display_name.trim();
    }
    if (patch.role !== undefined) {
      if (by && actor.id === by.id && patch.role !== "admin") {
        throw forbidden("You cannot demote yourself", "Ask another admin to change your role.");
      }
      sets.push("role = ?");
      params.push(patch.role);
      changed.role = patch.role;
    }
    if (patch.kind !== undefined) {
      sets.push("kind = ?");
      params.push(patch.kind);
      changed.kind = patch.kind;
    }
    if (patch.owner !== undefined) {
      const ownerId = this.resolveOwner(patch.owner, patch.kind ?? actor.kind);
      if (ownerId === actor.id) throw invalid("An actor cannot own itself");
      sets.push("owner_id = ?");
      params.push(ownerId);
      changed.owner = patch.owner;
    }
    if (patch.context !== undefined) {
      sets.push("context = ?");
      params.push(patch.context?.trim() || null);
      changed.context = patch.context;
    }
    if (patch.active !== undefined) {
      if (by && actor.id === by.id && !patch.active) {
        throw forbidden("You cannot deactivate yourself", "Ask another admin to do it.");
      }
      sets.push("active = ?");
      params.push(patch.active ? 1 : 0);
      changed.active = patch.active;
    }
    if (sets.length === 0) throw invalid("Nothing to update", "Pass at least one field to change.");

    return this.db.transaction(() => {
      this.db.run(`UPDATE actors SET ${sets.join(", ")} WHERE id = ?`, ...params, actor.id);
      this.logActorEvent(by?.id ?? actor.id, "actor.updated", { handle: actor.handle, changed, ...(by ? {} : { via: "cli" }) });
      return this.byId(actor.id)!;
    });
  }

  /** Issues a fresh token and invalidates the previous one. */
  rotateToken(handle: string, by: Actor | null): { actor: Actor; token: string } {
    const actor = this.require(handle);
    const token = generateToken();
    return this.db.transaction(() => {
      this.db.run("UPDATE actors SET token_hash = ? WHERE id = ?", hashToken(token), actor.id);
      this.logActorEvent(by?.id ?? actor.id, "actor.token_rotated", { handle: actor.handle, ...(by ? {} : { via: "cli" }) });
      return { actor: this.byId(actor.id)!, token };
    });
  }

  private resolveOwner(owner: string | null | undefined, kind: ActorKind): number | null {
    if (owner == null || owner === "") {
      return null;
    }
    const o = this.require(owner);
    if (kind === "human" && o.kind !== "human") {
      throw invalid("A human actor cannot be owned by an agent or bot");
    }
    return o.id;
  }

  private logActorEvent(actorId: number, type: string, data: Record<string, unknown>): void {
    this.db.run(
      "INSERT INTO events(task_id, actor_id, type, data, created_at) VALUES (NULL, ?, ?, ?, ?)",
      actorId,
      type,
      JSON.stringify(data),
      nowIso(),
    );
  }
}
