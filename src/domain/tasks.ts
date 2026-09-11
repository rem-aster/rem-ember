import type { Db, Row } from "../db.js";
import { parseJsonArray, parseJsonObject } from "../db.js";
import type { Config } from "../config.js";
import { EmberError, conflict, forbidden, invalid, notFound } from "../errors.js";
import { addMinutesIso, normalizeHandle, nowIso, parseTaskKey, taskKey } from "../ids.js";
import type {
  Actor,
  Claim,
  ClaimPurpose,
  Comment,
  CommentKind,
  Event,
  Priority,
  Role,
  Status,
  Task,
  TaskKind,
} from "../types.js";
import { ROLES } from "../types.js";
import type { ActorService } from "./actors.js";
import {
  CLAIM_RULES,
  CLOSED_STATUSES,
  FIELD_ROLES,
  OPEN_STATUSES,
  REVERT_ON_RELEASE,
  TRANSITIONS,
  allowedTransitions,
  hasRole,
  isClaimHolder,
} from "./workflow.js";

const TASK_SELECT = `
  SELECT t.*,
    rp.handle AS reporter_handle,
    an.handle AS analyst_handle,
    asg.handle AS assignee_handle,
    cl.handle AS claim_handle
  FROM tasks t
  JOIN actors rp ON rp.id = t.reporter_id
  LEFT JOIN actors an ON an.id = t.analyst_id
  LEFT JOIN actors asg ON asg.id = t.assignee_id
  LEFT JOIN actors cl ON cl.id = t.claim_actor_id`;

const PRIORITY_ORDER =
  "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";

const CLEAR_CLAIM_SQL =
  "claim_actor_id = NULL, claim_purpose = NULL, claim_note = NULL, claim_at = NULL, claim_expires_at = NULL";

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function rowToTask(r: Row): Task {
  const id = Number(r.id);
  const claim: Claim | null =
    r.claim_actor_id == null
      ? null
      : {
          actor: String(r.claim_handle),
          purpose: r.claim_purpose as ClaimPurpose,
          note: str(r.claim_note),
          claimed_at: String(r.claim_at),
          expires_at: String(r.claim_expires_at),
        };
  return {
    id,
    key: taskKey(id),
    title: String(r.title),
    status: r.status as Status,
    priority: r.priority as Priority,
    kind: r.kind as TaskKind,
    raw: String(r.raw),
    problem: str(r.problem),
    analysis: str(r.analysis),
    acceptance: str(r.acceptance),
    labels: parseJsonArray(r.labels),
    refs: parseJsonArray(r.refs),
    source_channel: String(r.source_channel),
    source_ref: str(r.source_ref),
    source_author: str(r.source_author),
    reporter: String(r.reporter_handle),
    analyst: str(r.analyst_handle),
    assignee: str(r.assignee_handle),
    claim,
    blocked_by: parseJsonArray(r.blocked_by),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    done_at: str(r.done_at),
  };
}

function rowToComment(r: Row): Comment {
  return {
    id: Number(r.id),
    task_key: taskKey(Number(r.task_id)),
    actor: String(r.actor_handle),
    kind: r.kind as CommentKind,
    body: String(r.body),
    to_actor: str(r.to_handle),
    to_role: (str(r.to_role) as Role | null) ?? null,
    reply_to: r.reply_to == null ? null : Number(r.reply_to),
    resolved_at: str(r.resolved_at),
    created_at: String(r.created_at),
  };
}

function rowToEvent(r: Row): Event {
  return {
    id: Number(r.id),
    task_key: r.task_id == null ? null : taskKey(Number(r.task_id)),
    actor: String(r.actor_handle),
    type: String(r.type),
    data: parseJsonObject(r.data),
    created_at: String(r.created_at),
  };
}

const COMMENT_SELECT = `
  SELECT c.*, a.handle AS actor_handle, ta.handle AS to_handle
  FROM comments c
  JOIN actors a ON a.id = c.actor_id
  LEFT JOIN actors ta ON ta.id = c.to_actor_id`;

const EVENT_SELECT = `SELECT e.*, a.handle AS actor_handle FROM events e JOIN actors a ON a.id = e.actor_id`;

export interface CreateTaskInput {
  title: string;
  raw: string;
  source_channel?: string;
  source_ref?: string | null;
  source_author?: string | null;
  priority?: Priority;
  kind?: TaskKind;
  labels?: string[];
  problem?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  problem?: string | null;
  analysis?: string | null;
  acceptance?: string | null;
  priority?: Priority;
  kind?: TaskKind;
  labels?: string[];
  add_labels?: string[];
  remove_labels?: string[];
  add_refs?: string[];
  remove_refs?: string[];
  assignee?: string | null;
  blocked_by?: string[];
  note?: string;
}

export interface ListTasksInput {
  status?: Status[];
  assignee?: string;
  claimed_by?: string;
  reporter?: string;
  label?: string;
  priority?: Priority;
  kind?: TaskKind;
  query?: string;
  updated_since?: string;
  include_closed?: boolean;
  limit: number;
  offset: number;
}

export interface CommentInput {
  body: string;
  kind: CommentKind;
  to?: string | null;
  reply_to?: number | null;
}

export interface OpenQuestion {
  comment_id: number;
  task_key: string;
  task_title: string;
  from: string;
  to_actor: string | null;
  to_role: Role | null;
  body: string;
  created_at: string;
}

export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly actors: ActorService,
    private readonly cfg: Config,
  ) {}

  // ----------------------------- reads -----------------------------

  byKey(key: string | number): Task | undefined {
    const id = parseTaskKey(key);
    const r = this.db.get(`${TASK_SELECT} WHERE t.id = ?`, id);
    return r ? rowToTask(r) : undefined;
  }

  require(key: string | number): Task {
    const t = this.byKey(key);
    if (!t) {
      throw notFound(`Task ${taskKey(parseTaskKey(key))} does not exist`, "Use ember_list_tasks to find tasks.");
    }
    return t;
  }

  comments(taskId: number): Comment[] {
    return this.db.all(`${COMMENT_SELECT} WHERE c.task_id = ? ORDER BY c.id`, taskId).map(rowToComment);
  }

  events(opts: { taskId?: number; actorId?: number; since?: string; limit: number }): Event[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.taskId !== undefined) {
      where.push("e.task_id = ?");
      params.push(opts.taskId);
    }
    if (opts.actorId !== undefined) {
      where.push("e.actor_id = ?");
      params.push(opts.actorId);
    }
    if (opts.since) {
      where.push("e.created_at > ?");
      params.push(opts.since);
    }
    const sql = `${EVENT_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY e.id DESC LIMIT ?`;
    return this.db.all(sql, ...params, opts.limit).map(rowToEvent);
  }

  list(input: ListTasksInput): { total: number; items: Task[] } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (input.status && input.status.length > 0) {
      where.push(`t.status IN (${input.status.map(() => "?").join(",")})`);
      params.push(...input.status);
    } else if (!input.include_closed) {
      where.push(`t.status NOT IN ('done','dropped')`);
    }
    if (input.assignee) {
      where.push("asg.handle = ?");
      params.push(normalizeHandle(input.assignee));
    }
    if (input.claimed_by) {
      where.push("cl.handle = ?");
      params.push(normalizeHandle(input.claimed_by));
    }
    if (input.reporter) {
      where.push("rp.handle = ?");
      params.push(normalizeHandle(input.reporter));
    }
    if (input.priority) {
      where.push("t.priority = ?");
      params.push(input.priority);
    }
    if (input.kind) {
      where.push("t.kind = ?");
      params.push(input.kind);
    }
    if (input.label) {
      where.push("EXISTS (SELECT 1 FROM json_each(t.labels) WHERE json_each.value = ?)");
      params.push(input.label.trim().toLowerCase());
    }
    if (input.updated_since) {
      where.push("t.updated_at > ?");
      params.push(input.updated_since);
    }
    if (input.query) {
      const cols = ["t.title", "t.raw", "t.problem", "t.analysis", "t.acceptance", "t.source_author"];
      for (const term of input.query.split(/\s+/).filter(Boolean)) {
        where.push("(" + cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ") + ")");
        const like = `%${term.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
        for (let i = 0; i < cols.length; i++) params.push(like);
      }
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = Number(
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tasks t
           JOIN actors rp ON rp.id = t.reporter_id
           LEFT JOIN actors asg ON asg.id = t.assignee_id
           LEFT JOIN actors cl ON cl.id = t.claim_actor_id ${whereSql}`,
        ...params,
      )?.n ?? 0,
    );
    const items = this.db
      .all(
        `${TASK_SELECT} ${whereSql} ORDER BY ${PRIORITY_ORDER}, t.updated_at DESC LIMIT ? OFFSET ?`,
        ...params,
        input.limit,
        input.offset,
      )
      .map(rowToTask);
    return { total, items };
  }

  openQuestions(opts: { forActor?: Actor; limit?: number } = {}): OpenQuestion[] {
    const where = ["c.kind = 'question'", "c.resolved_at IS NULL", "t.status NOT IN ('done','dropped')"];
    const params: (string | number)[] = [];
    if (opts.forActor) {
      where.push("(c.to_actor_id = ? OR c.to_role = ?)");
      params.push(opts.forActor.id, opts.forActor.role);
    }
    const rows = this.db.all(
      `SELECT c.id, c.task_id, c.body, c.created_at, c.to_role, a.handle AS from_handle, ta.handle AS to_handle, t.title
       FROM comments c
       JOIN tasks t ON t.id = c.task_id
       JOIN actors a ON a.id = c.actor_id
       LEFT JOIN actors ta ON ta.id = c.to_actor_id
       WHERE ${where.join(" AND ")} ORDER BY c.id DESC LIMIT ?`,
      ...params,
      opts.limit ?? 50,
    );
    return rows.map((r) => ({
      comment_id: Number(r.id),
      task_key: taskKey(Number(r.task_id)),
      task_title: String(r.title),
      from: String(r.from_handle),
      to_actor: str(r.to_handle),
      to_role: (str(r.to_role) as Role | null) ?? null,
      body: String(r.body),
      created_at: String(r.created_at),
    }));
  }

  claimsOf(actor: Actor): Task[] {
    return this.db
      .all(`${TASK_SELECT} WHERE t.claim_actor_id = ? ORDER BY t.claim_expires_at`, actor.id)
      .map(rowToTask);
  }

  /** Releases claims whose lease expired; reverts status. Cheap; called on every authenticated request. */
  sweepExpiredClaims(): number {
    const now = nowIso();
    const rows = this.db.all(`${TASK_SELECT} WHERE t.claim_actor_id IS NOT NULL AND t.claim_expires_at < ?`, now);
    if (rows.length === 0) return 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const task = rowToTask(r);
        const claim = task.claim!;
        const revert = REVERT_ON_RELEASE[task.status] ?? task.status;
        this.db.run(
          `UPDATE tasks SET status = ?, ${CLEAR_CLAIM_SQL}, updated_at = ? WHERE id = ?`,
          revert,
          now,
          task.id,
        );
        this.logEvent(task.id, Number(r.claim_actor_id), "task.claim_expired", {
          purpose: claim.purpose,
          from: task.status,
          to: revert,
          expired_at: claim.expires_at,
        });
      }
    });
    return rows.length;
  }

  // ----------------------------- writes -----------------------------

  create(input: CreateTaskInput, by: Actor): { task: Task; created: boolean } {
    const sourceRef = input.source_ref?.trim() || null;
    if (sourceRef) {
      const existing = this.db.get(`${TASK_SELECT} WHERE t.source_ref = ?`, sourceRef);
      if (existing) return { task: rowToTask(existing), created: false };
    }
    if (!input.title.trim()) throw invalid("Title cannot be empty");
    if (!input.raw.trim()) throw invalid("raw cannot be empty", "Put the original request text (verbatim) into raw.");
    const now = nowIso();
    const labels = normalizeLabels(input.labels ?? []);
    return this.db.transaction(() => {
      const { lastId } = this.db.run(
        `INSERT INTO tasks(title, status, priority, kind, raw, problem, labels, source_channel, source_ref, source_author, reporter_id, created_at, updated_at)
         VALUES (?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.title.trim(),
        input.priority ?? "normal",
        input.kind ?? "other",
        input.raw,
        input.problem?.trim() || null,
        JSON.stringify(labels),
        (input.source_channel ?? "manual").trim().toLowerCase(),
        sourceRef,
        input.source_author?.trim() || null,
        by.id,
        now,
        now,
      );
      this.logEvent(lastId, by.id, "task.created", {
        title: input.title.trim(),
        source_channel: input.source_channel ?? "manual",
        priority: input.priority ?? "normal",
      });
      return { task: this.byKey(lastId)!, created: true };
    });
  }

  update(key: string, patch: UpdateTaskInput, by: Actor): Task {
    const task = this.require(key);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const changed: Record<string, unknown> = {};

    const touched = (Object.keys(patch) as (keyof UpdateTaskInput)[]).filter(
      (k) => k !== "note" && patch[k] !== undefined,
    );
    if (touched.length === 0) throw invalid("Nothing to update", "Pass at least one field to change.");
    for (const field of touched) {
      const roles = FIELD_ROLES[field];
      if (!roles) throw invalid(`Unknown field "${field}"`);
      if (!hasRole(by, roles)) {
        throw forbidden(
          `Role "${by.role}" cannot change "${field}"`,
          `Allowed roles: ${roles.join(", ")}. Leave a comment for them instead (ember_comment_task).`,
        );
      }
    }

    const setText = (col: "problem" | "analysis" | "acceptance", value: string | null | undefined) => {
      if (value === undefined) return;
      const v = value === null || value.trim() === "" ? null : value;
      sets.push(`${col} = ?`);
      params.push(v);
      changed[col] = v === null ? null : summarize(v);
    };

    if (patch.title !== undefined) {
      if (patch.title.trim() === "") throw invalid("Title cannot be empty");
      sets.push("title = ?");
      params.push(patch.title.trim());
      changed.title = { from: task.title, to: patch.title.trim() };
    }
    setText("problem", patch.problem);
    setText("analysis", patch.analysis);
    setText("acceptance", patch.acceptance);
    if (patch.priority !== undefined) {
      sets.push("priority = ?");
      params.push(patch.priority);
      changed.priority = { from: task.priority, to: patch.priority };
    }
    if (patch.kind !== undefined) {
      sets.push("kind = ?");
      params.push(patch.kind);
      changed.kind = { from: task.kind, to: patch.kind };
    }

    let labels = task.labels;
    if (patch.labels !== undefined) labels = normalizeLabels(patch.labels);
    if (patch.add_labels) labels = normalizeLabels([...labels, ...patch.add_labels]);
    if (patch.remove_labels) {
      const rm = new Set(normalizeLabels(patch.remove_labels));
      labels = labels.filter((l) => !rm.has(l));
    }
    if (labels.join(" ") !== task.labels.join(" ")) {
      sets.push("labels = ?");
      params.push(JSON.stringify(labels));
      changed.labels = labels;
    }

    let refs = task.refs;
    if (patch.add_refs) refs = dedupe([...refs, ...patch.add_refs.map((r) => r.trim()).filter(Boolean)]);
    if (patch.remove_refs) {
      const rm = new Set(patch.remove_refs.map((r) => r.trim()));
      refs = refs.filter((r) => !rm.has(r));
    }
    if (refs.join(" ") !== task.refs.join(" ")) {
      sets.push("refs = ?");
      params.push(JSON.stringify(refs));
      changed.refs = refs;
    }

    if (patch.assignee !== undefined) {
      const assignee =
        patch.assignee === null || patch.assignee === "" ? null : this.actors.require(patch.assignee);
      if (assignee && assignee.role === "reporter") {
        throw invalid(`@${assignee.handle} has role "reporter" and cannot be assigned work`);
      }
      sets.push("assignee_id = ?");
      params.push(assignee ? assignee.id : null);
      changed.assignee = { from: task.assignee, to: assignee?.handle ?? null };
    }

    if (patch.blocked_by !== undefined) {
      const keys = dedupe(patch.blocked_by.map((k) => taskKey(parseTaskKey(k))));
      for (const k of keys) {
        if (k === task.key) throw invalid("A task cannot block itself");
        this.require(k);
      }
      sets.push("blocked_by = ?");
      params.push(JSON.stringify(keys));
      changed.blocked_by = keys;
    }

    if (sets.length === 0) return task; // nothing effectively changed
    const now = nowIso();
    return this.db.transaction(() => {
      this.db.run(`UPDATE tasks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, now, task.id);
      this.logEvent(task.id, by.id, "task.updated", { changed, ...(patch.note ? { note: patch.note } : {}) });
      return this.byKey(task.id)!;
    });
  }

  claim(
    key: string,
    by: Actor,
    opts: { purpose: ClaimPurpose; ttl_minutes?: number; note?: string | null; take_over?: boolean },
  ): { task: Task; extended: boolean } {
    const task = this.require(key);
    const rule = CLAIM_RULES[opts.purpose];
    if (!hasRole(by, rule.roles)) {
      throw forbidden(
        `Role "${by.role}" cannot claim tasks for ${opts.purpose}`,
        `Allowed roles: ${rule.roles.join(", ")}.`,
      );
    }
    const ttl = opts.ttl_minutes ?? this.cfg.defaultClaimTtlMinutes;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > this.cfg.maxClaimTtlMinutes) {
      throw invalid(`ttl_minutes must be between 1 and ${this.cfg.maxClaimTtlMinutes}`);
    }

    // Same holder re-claiming: heartbeat / extend the lease.
    if (task.claim && task.claim.actor === by.handle) {
      if (task.claim.purpose !== opts.purpose) {
        throw conflict(
          `You already hold ${task.key} for ${task.claim.purpose}`,
          "Release it first (ember_release_task) or keep the same purpose to extend the lease.",
        );
      }
      const expires = addMinutesIso(ttl);
      this.db.transaction(() => {
        this.db.run(
          "UPDATE tasks SET claim_expires_at = ?, claim_note = COALESCE(?, claim_note), updated_at = ? WHERE id = ?",
          expires,
          opts.note?.trim() || null,
          nowIso(),
          task.id,
        );
        this.logEvent(task.id, by.id, "task.claim_extended", { purpose: opts.purpose, expires_at: expires });
      });
      return { task: this.byKey(task.id)!, extended: true };
    }

    if (task.claim) {
      throw conflict(
        `${task.key} is currently held by @${task.claim.actor} for ${task.claim.purpose} until ${task.claim.expires_at}`,
        "Coordinate with the holder (ember_comment_task kind=question to=@handle) or wait for the lease to expire.",
        { holder: task.claim.actor, purpose: task.claim.purpose, expires_at: task.claim.expires_at },
      );
    }

    const nextStatus = rule.from[task.status];
    if (!nextStatus) {
      throw conflict(
        `Cannot claim ${task.key} for ${opts.purpose} while it is in status "${task.status}"`,
        `Claim for ${opts.purpose} is possible from: ${Object.keys(rule.from).join(", ")}.`,
      );
    }

    if (opts.purpose === "implementation") {
      if (task.assignee && task.assignee !== by.handle && !opts.take_over) {
        throw conflict(
          `${task.key} is assigned to @${task.assignee}`,
          "Pass take_over: true to reassign it to yourself, or pick another task from ember_my_work.",
          { assignee: task.assignee },
        );
      }
      const blockers = this.openBlockers(task);
      if (blockers.length > 0) {
        throw conflict(
          `${task.key} is blocked by open tasks: ${blockers.map((b) => `${b.key} (${b.status})`).join(", ")}`,
          "Finish the blockers first or edit blocked_by via ember_update_task if the dependency is obsolete.",
          { blocked_by: blockers.map((b) => b.key) },
        );
      }
    }
    if (opts.purpose === "review" && task.assignee === by.handle && by.role !== "admin") {
      throw conflict(
        `You implemented ${task.key}; someone else should review it`,
        "Ask another developer or a manager via ember_comment_task kind=question to=role:developer.",
      );
    }

    const myClaims = this.claimsOf(by);
    if (myClaims.length >= this.cfg.maxClaimsPerActor) {
      throw new EmberError(
        "wip_limit",
        `You already hold ${myClaims.length} task(s): ${myClaims.map((t) => t.key).join(", ")} (limit ${this.cfg.maxClaimsPerActor})`,
        "Finish or release one of them (ember_release_task) before pulling more work. Lean: stop starting, start finishing.",
        { claims: myClaims.map((t) => t.key) },
      );
    }
    const statusLimit = this.cfg.wipLimits[nextStatus];
    if (statusLimit !== undefined && nextStatus !== task.status) {
      const inStatus = Number(
        this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status = ?", nextStatus)?.n ?? 0,
      );
      if (inStatus >= statusLimit) {
        throw new EmberError(
          "wip_limit",
          `WIP limit for "${nextStatus}" reached (${inStatus}/${statusLimit})`,
          "Help finish something already in progress instead of starting new work.",
        );
      }
    }

    const now = nowIso();
    const expires = addMinutesIso(ttl);
    const previousAssignee = task.assignee;
    this.db.transaction(() => {
      const setAssignee = opts.purpose === "implementation";
      this.db.run(
        `UPDATE tasks SET status = ?, claim_actor_id = ?, claim_purpose = ?, claim_note = ?, claim_at = ?, claim_expires_at = ?,
           assignee_id = CASE WHEN ? THEN ? ELSE assignee_id END, updated_at = ? WHERE id = ?`,
        nextStatus,
        by.id,
        opts.purpose,
        opts.note?.trim() || null,
        now,
        expires,
        setAssignee ? 1 : 0,
        by.id,
        now,
        task.id,
      );
      this.logEvent(task.id, by.id, "task.claimed", {
        purpose: opts.purpose,
        from: task.status,
        to: nextStatus,
        expires_at: expires,
        ...(opts.note ? { note: opts.note } : {}),
        ...(setAssignee && previousAssignee && previousAssignee !== by.handle ? { reassigned_from: previousAssignee } : {}),
      });
    });
    return { task: this.byKey(task.id)!, extended: false };
  }

  release(key: string, by: Actor, opts: { note?: string | null; unassign?: boolean } = {}): Task {
    const task = this.require(key);
    if (!task.claim) {
      throw conflict(`${task.key} is not claimed by anyone`, "Nothing to release.");
    }
    const isHolder = task.claim.actor === by.handle;
    if (!isHolder && !hasRole(by, ["admin", "manager"])) {
      throw forbidden(
        `${task.key} is held by @${task.claim.actor}, not you`,
        "Only the holder, a manager or an admin can release it. Leases also expire automatically.",
      );
    }
    if (!isHolder && !opts.note?.trim()) {
      throw invalid("A note is required when releasing someone else's claim");
    }
    const revert = REVERT_ON_RELEASE[task.status] ?? task.status;
    const now = nowIso();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE tasks SET status = ?, ${CLEAR_CLAIM_SQL},
           assignee_id = CASE WHEN ? THEN NULL ELSE assignee_id END, updated_at = ? WHERE id = ?`,
        revert,
        opts.unassign ? 1 : 0,
        now,
        task.id,
      );
      this.logEvent(task.id, by.id, "task.released", {
        purpose: task.claim!.purpose,
        holder: task.claim!.actor,
        from: task.status,
        to: revert,
        unassigned: Boolean(opts.unassign),
        ...(opts.note ? { note: opts.note } : {}),
      });
    });
    return this.byKey(task.id)!;
  }

  transition(key: string, to: Status, by: Actor, note?: string | null): Task {
    const task = this.require(key);
    if (task.status === to) throw conflict(`${task.key} is already in status "${to}"`);
    const rule = TRANSITIONS[task.status]?.[to];
    if (!rule) {
      const allowed = allowedTransitions(task.status);
      const claimHint =
        task.status === "inbox"
          ? " To start analysis, use ember_claim_task purpose=analysis."
          : task.status === "ready" || task.status === "review"
            ? " To start (re)implementation, use ember_claim_task purpose=implementation."
            : "";
      throw conflict(
        `Transition ${task.status} -> ${to} is not allowed`,
        `From "${task.status}" you can go to: ${allowed.length ? allowed.join(", ") : "(none via transition)"}.${claimHint}`,
      );
    }
    const holder = isClaimHolder(task, by);
    const roleOk = hasRole(by, rule.roles);
    if (!roleOk && !(rule.holderAllowed && holder)) {
      throw forbidden(
        `Role "${by.role}" cannot move ${task.key} from ${task.status} to ${to}`,
        `Allowed: ${rule.roles.join(", ")}${rule.holderAllowed ? " or the current claim holder" : ""}.`,
      );
    }
    if (rule.holderOnly && task.claim && !holder && by.role !== "admin") {
      throw conflict(
        `${task.key} is held by @${task.claim.actor} (${task.claim.purpose}); only they can move it to ${to}`,
        "Ask them via a question comment, wait for the lease to expire, or have a manager release the claim.",
      );
    }
    if (rule.noteRequired && !note?.trim()) {
      throw invalid(`A note is required for ${task.status} -> ${to}`, "Explain why in the note field.");
    }
    const problem = rule.check?.(task);
    if (problem) throw conflict(problem);

    const now = nowIso();
    const e = rule.effects;
    this.db.transaction(() => {
      const sets = ["status = ?", "updated_at = ?"];
      const params: (string | number | null)[] = [to, now];
      if (e.clearClaim) sets.push(CLEAR_CLAIM_SQL);
      if (e.setAnalyst) {
        sets.push("analyst_id = ?");
        params.push(by.id);
      }
      if (e.clearAssignee) sets.push("assignee_id = NULL");
      if (e.setDone) {
        sets.push("done_at = ?");
        params.push(now);
      }
      if (e.clearDone) sets.push("done_at = NULL");
      this.db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params, task.id);
      this.logEvent(task.id, by.id, "task.status", { from: task.status, to, ...(note ? { note } : {}) });
    });
    return this.byKey(task.id)!;
  }

  comment(key: string, input: CommentInput, by: Actor): Comment {
    const task = this.require(key);
    if (!input.body.trim()) throw invalid("Comment body cannot be empty");
    let toActorId: number | null = null;
    let toRole: Role | null = null;
    if (input.to) {
      const raw = input.to.trim();
      if (raw.startsWith("role:")) {
        const r = raw.slice(5).trim();
        if (!(ROLES as readonly string[]).includes(r)) {
          throw invalid(`Unknown role "${r}"`, `Roles: ${ROLES.join(", ")}.`);
        }
        toRole = r as Role;
      } else {
        toActorId = this.actors.require(raw).id;
      }
    }
    let replyTo: number | null = null;
    if (input.reply_to != null) {
      const parent = this.db.get(`${COMMENT_SELECT} WHERE c.id = ? AND c.task_id = ?`, input.reply_to, task.id);
      if (!parent) throw notFound(`Comment #${input.reply_to} not found on ${task.key}`);
      replyTo = input.reply_to;
    }
    if (input.kind === "answer" && replyTo === null) {
      throw invalid(
        "An answer must reference the question via reply_to",
        "Find the question id in ember_get_task comments or ember_my_work questions_for_me.",
      );
    }
    const now = nowIso();
    return this.db.transaction(() => {
      const { lastId } = this.db.run(
        `INSERT INTO comments(task_id, actor_id, kind, body, to_actor_id, to_role, reply_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        task.id,
        by.id,
        input.kind,
        input.body,
        toActorId,
        toRole,
        replyTo,
        now,
      );
      let resolvedQuestion: number | null = null;
      if (input.kind === "answer" && replyTo !== null) {
        const r = this.db.run(
          "UPDATE comments SET resolved_at = ? WHERE id = ? AND kind = 'question' AND resolved_at IS NULL",
          now,
          replyTo,
        );
        if (r.changes > 0) resolvedQuestion = replyTo;
      }
      this.db.run("UPDATE tasks SET updated_at = ? WHERE id = ?", now, task.id);
      const type =
        input.kind === "question" ? "question.asked" : input.kind === "answer" ? "question.answered" : "comment.added";
      this.logEvent(task.id, by.id, type, {
        comment_id: lastId,
        kind: input.kind,
        ...(toActorId !== null ? { to: this.actors.byId(toActorId)?.handle } : {}),
        ...(toRole ? { to_role: toRole } : {}),
        ...(resolvedQuestion !== null ? { resolves: resolvedQuestion } : {}),
        preview: summarize(input.body, 120),
      });
      const row = this.db.get(`${COMMENT_SELECT} WHERE c.id = ?`, lastId)!;
      return rowToComment(row);
    });
  }

  // ----------------------------- aggregates -----------------------------

  myWork(actor: Actor) {
    const claims = this.claimsOf(actor).map((t) => ({
      task: t,
      purpose: t.claim!.purpose,
      expires_at: t.claim!.expires_at,
      minutes_left: Math.max(0, Math.round((Date.parse(t.claim!.expires_at) - Date.now()) / 60_000)),
    }));
    const assigned = this.db
      .all(
        `${TASK_SELECT} WHERE t.assignee_id = ? AND t.status NOT IN ('done','dropped')
           AND (t.claim_actor_id IS NULL OR t.claim_actor_id != ?)
         ORDER BY ${PRIORITY_ORDER}, t.updated_at DESC`,
        actor.id,
        actor.id,
      )
      .map(rowToTask);
    const questions = this.openQuestions({ forActor: actor, limit: 20 });

    const pull: Record<string, Task[]> = {};
    const queue = (sql: string, ...params: (string | number)[]) =>
      this.db
        .all(`${TASK_SELECT} WHERE ${sql} ORDER BY ${PRIORITY_ORDER}, t.created_at ASC LIMIT 10`, ...params)
        .map(rowToTask);

    if (actor.role === "developer" || actor.role === "admin") {
      pull.analysis = queue("t.status = 'inbox' AND t.claim_actor_id IS NULL");
      pull.implementation = queue(
        "t.status = 'ready' AND t.claim_actor_id IS NULL AND (t.assignee_id IS NULL OR t.assignee_id = ?)",
        actor.id,
      ).filter((t) => this.openBlockers(t).length === 0);
      pull.review = queue(
        "t.status = 'review' AND t.claim_actor_id IS NULL AND (t.assignee_id IS NULL OR t.assignee_id != ?)",
        actor.id,
      );
    }
    if (actor.role === "manager" || actor.role === "admin") {
      pull.triage = queue("t.status = 'inbox' AND (t.problem IS NULL OR t.problem = '')");
      pull.verify = queue("t.status = 'review' AND t.claim_actor_id IS NULL");
    }
    if (actor.role === "reporter") {
      pull.reported_open = queue("t.reporter_id = ? AND t.status NOT IN ('done','dropped')", actor.id);
    }

    return {
      actor: actor.handle,
      role: actor.role,
      wip: { claims: claims.length, max_claims: this.cfg.maxClaimsPerActor },
      claims,
      assigned_not_claimed: assigned,
      questions_for_me: questions,
      pull,
    };
  }

  board() {
    const counts: Record<Status, number> = {
      inbox: 0,
      analysis: 0,
      ready: 0,
      in_progress: 0,
      review: 0,
      done: 0,
      dropped: 0,
    };
    for (const r of this.db.all<{ status: Status; n: number }>(
      "SELECT status, COUNT(*) AS n FROM tasks GROUP BY status",
    )) {
      counts[r.status] = Number(r.n);
    }
    const oldest: Partial<Record<Status, { key: string; age_hours: number }>> = {};
    for (const s of OPEN_STATUSES) {
      const r = this.db.get<{ id: number; updated_at: string }>(
        "SELECT id, updated_at FROM tasks WHERE status = ? ORDER BY updated_at ASC LIMIT 1",
        s,
      );
      if (r) {
        oldest[s] = {
          key: taskKey(Number(r.id)),
          age_hours: Math.round((Date.now() - Date.parse(r.updated_at)) / 3_600_000),
        };
      }
    }
    const active = this.db
      .all(`${TASK_SELECT} WHERE t.claim_actor_id IS NOT NULL ORDER BY t.claim_expires_at`)
      .map(rowToTask)
      .map((t) => ({
        key: t.key,
        title: t.title,
        status: t.status,
        holder: t.claim!.actor,
        purpose: t.claim!.purpose,
        expires_at: t.claim!.expires_at,
        note: t.claim!.note,
      }));
    const stalled = this.db
      .all(
        `${TASK_SELECT} WHERE t.status IN ('analysis','in_progress') AND t.claim_actor_id IS NULL ORDER BY t.updated_at`,
      )
      .map(rowToTask)
      .map((t) => ({ key: t.key, title: t.title, status: t.status, assignee: t.assignee, updated_at: t.updated_at }));
    const urgent = this.db
      .all(
        `${TASK_SELECT} WHERE t.priority IN ('urgent','high') AND t.status NOT IN ('done','dropped')
         ORDER BY ${PRIORITY_ORDER}, t.created_at LIMIT 10`,
      )
      .map(rowToTask)
      .map((t) => ({ key: t.key, title: t.title, status: t.status, priority: t.priority, assignee: t.assignee }));
    const doneLast7d = Number(
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM tasks WHERE done_at > ?",
        new Date(Date.now() - 7 * 86_400_000).toISOString(),
      )?.n ?? 0,
    );
    return {
      counts,
      open_total: OPEN_STATUSES.reduce((s, k) => s + counts[k], 0),
      closed_total: CLOSED_STATUSES.reduce((s, k) => s + counts[k], 0),
      done_last_7d: doneLast7d,
      wip_limits: { per_actor_claims: this.cfg.maxClaimsPerActor, per_status: this.cfg.wipLimits },
      oldest_per_status: oldest,
      active_claims: active,
      stalled_without_claim: stalled,
      open_questions: this.openQuestions({ limit: 20 }),
      urgent_open: urgent,
    };
  }

  // ----------------------------- helpers -----------------------------

  openBlockers(task: Task): { key: string; status: Status }[] {
    const out: { key: string; status: Status }[] = [];
    for (const k of task.blocked_by) {
      const b = this.byKey(k);
      if (b && !CLOSED_STATUSES.includes(b.status)) out.push({ key: b.key, status: b.status });
    }
    return out;
  }

  private logEvent(taskId: number | null, actorId: number, type: string, data: Record<string, unknown>): void {
    this.db.run(
      "INSERT INTO events(task_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
      taskId,
      actorId,
      type,
      JSON.stringify(data),
      nowIso(),
    );
  }
}

function normalizeLabels(labels: string[]): string[] {
  return dedupe(labels.map((l) => l.trim().toLowerCase()).filter(Boolean));
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function summarize(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 3) + "..." : oneLine;
}
