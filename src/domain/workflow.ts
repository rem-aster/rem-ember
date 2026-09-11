/**
 * Pure workflow rules: the Lean value stream, who may do what, and when.
 *
 *   inbox ──claim(analysis)──▶ analysis ──transition──▶ ready ──claim(implementation)──▶ in_progress ──▶ review ──▶ done
 *     ▲                          │ release/expire         ▲                                │ release/expire   │
 *     └──────────────────────────┘                        └────────────────────────────────┘                  └─▶ ready/in_progress (rework)
 *   any open status ──▶ dropped ──▶ inbox (reopen)
 */
import type { Actor, ClaimPurpose, Role, Status, Task } from "../types.js";

export const OPEN_STATUSES: readonly Status[] = ["inbox", "analysis", "ready", "in_progress", "review"];
export const CLOSED_STATUSES: readonly Status[] = ["done", "dropped"];

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Full access, manages actors and tokens.",
  manager:
    "Product/management context (no code access). Creates and refines tasks (problem, priority, acceptance), drops tasks, verifies review -> done, answers questions.",
  developer:
    "Code context. Claims tasks for analysis/implementation/review, writes technical analysis and refs, moves tasks through the flow.",
  reporter: "Ingest bots and stakeholders. Creates tasks and comments, read-only otherwise.",
};

export interface TransitionRule {
  /** Roles allowed to perform the transition (claim holder is always allowed when `holderAllowed`). */
  roles: readonly Role[];
  /** If true, the current claim holder may perform it regardless of role list. */
  holderAllowed?: boolean;
  /** If true, only the claim holder (or admin) may perform it when a claim exists. */
  holderOnly?: boolean;
  noteRequired?: boolean;
  /** Extra precondition; returns an error message or null. */
  check?: (task: Task) => string | null;
  /** Side effects applied by the task service. */
  effects: {
    clearClaim?: boolean;
    setAnalyst?: boolean;
    clearAssignee?: boolean;
    setDone?: boolean;
    clearDone?: boolean;
  };
  hint?: string;
}

const needsAnalysis = (t: Task): string | null =>
  t.analysis && t.analysis.trim().length > 0
    ? null
    : "Task has no technical analysis yet. Write it first with ember_update_task { analysis: ... }.";

const ALL: readonly Role[] = ["admin", "manager", "developer", "reporter"];
const STAFF: readonly Role[] = ["admin", "manager", "developer"];
const DEV: readonly Role[] = ["admin", "developer"];

/** Explicit transitions available via ember_transition_task. Claims/releases move inbox↔analysis and ready↔in_progress. */
export const TRANSITIONS: Partial<Record<Status, Partial<Record<Status, TransitionRule>>>> = {
  inbox: {
    ready: {
      roles: DEV,
      check: needsAnalysis,
      effects: { setAnalyst: true },
      hint: "Skips the analysis phase for trivial tasks whose analysis is already written.",
    },
    dropped: { roles: STAFF, noteRequired: true, effects: {} },
  },
  analysis: {
    ready: {
      roles: ["admin"],
      holderAllowed: true,
      holderOnly: true,
      check: needsAnalysis,
      effects: { clearClaim: true, setAnalyst: true },
      hint: "Analysis is complete; the task can be pulled for implementation.",
    },
    dropped: { roles: ["admin", "manager"], holderAllowed: true, noteRequired: true, effects: { clearClaim: true } },
  },
  ready: {
    inbox: {
      roles: STAFF,
      noteRequired: true,
      effects: {},
      hint: "Send back for more analysis; say what is missing in the note.",
    },
    dropped: { roles: STAFF, noteRequired: true, effects: {} },
  },
  in_progress: {
    review: {
      roles: ["admin"],
      holderAllowed: true,
      holderOnly: true,
      effects: { clearClaim: true },
      hint: "Add the MR/PR link via ember_update_task { add_refs: [...] } before or right after.",
    },
    ready: {
      roles: ["admin", "manager"],
      holderAllowed: true,
      noteRequired: true,
      effects: { clearClaim: true, clearAssignee: true },
      hint: "Gives the task back to the pool. To keep it assigned to you, use ember_release_task instead.",
    },
    dropped: { roles: ["admin", "manager"], holderAllowed: true, noteRequired: true, effects: { clearClaim: true } },
  },
  review: {
    done: {
      roles: STAFF,
      holderOnly: true,
      effects: { clearClaim: true, setDone: true },
      hint: "Whoever verifies the result marks it done; the event records who.",
    },
    ready: {
      roles: STAFF,
      holderOnly: true,
      noteRequired: true,
      effects: { clearClaim: true },
      hint: "Rework needed; the assignee keeps the task and re-claims it. Explain what to fix in the note.",
    },
    dropped: { roles: STAFF, noteRequired: true, effects: { clearClaim: true } },
  },
  done: {
    ready: { roles: STAFF, noteRequired: true, effects: { clearDone: true }, hint: "Reopen keeping the analysis." },
    inbox: { roles: STAFF, noteRequired: true, effects: { clearDone: true, clearAssignee: true }, hint: "Reopen for re-analysis." },
  },
  dropped: {
    inbox: { roles: STAFF, noteRequired: true, effects: {} },
  },
};

export function allowedTransitions(status: Status): Status[] {
  return Object.keys(TRANSITIONS[status] ?? {}) as Status[];
}

export interface ClaimRule {
  roles: readonly Role[];
  /** status → resulting status */
  from: Partial<Record<Status, Status>>;
}

export const CLAIM_RULES: Record<ClaimPurpose, ClaimRule> = {
  analysis: { roles: DEV, from: { inbox: "analysis", analysis: "analysis" } },
  implementation: {
    roles: DEV,
    from: { ready: "in_progress", in_progress: "in_progress", review: "in_progress" },
  },
  review: { roles: STAFF, from: { review: "review" } },
};

/** Where a task goes when its claim is released or expires without completion. */
export const REVERT_ON_RELEASE: Partial<Record<Status, Status>> = {
  analysis: "inbox",
  in_progress: "ready",
};

/** Field-level write permissions for ember_update_task. */
export const FIELD_ROLES: Record<string, readonly Role[]> = {
  title: STAFF,
  problem: STAFF,
  acceptance: STAFF,
  priority: STAFF,
  kind: STAFF,
  labels: STAFF,
  add_labels: STAFF,
  remove_labels: STAFF,
  assignee: STAFF,
  blocked_by: STAFF,
  analysis: DEV,
  add_refs: DEV,
  remove_refs: DEV,
};

export const TOOL_ROLES = {
  read: ALL,
  create_task: ALL,
  comment: ALL,
  update_task: STAFF,
  claim: STAFF,
  transition: STAFF,
  admin: ["admin"] as readonly Role[],
};

export function hasRole(actor: Actor, roles: readonly Role[]): boolean {
  return roles.includes(actor.role);
}

export function isClaimHolder(task: Task, actor: Actor): boolean {
  return task.claim !== null && task.claim.actor === actor.handle;
}

/** Human-readable capability summary for whoami. */
export function capabilitiesFor(role: Role): string[] {
  const caps = ["read tasks, actors, activity and board", "create tasks", "comment, ask and answer questions"];
  if (role === "reporter") return caps;
  caps.push("edit title/problem/acceptance/priority/kind/labels/assignee/blocked_by");
  if (role === "manager") {
    caps.push("claim tasks for review (verification)", "drop tasks, reopen tasks, mark review -> done");
    return caps;
  }
  caps.push(
    "write technical analysis and refs",
    "claim tasks for analysis / implementation / review",
    "move tasks: analysis -> ready, in_progress -> review, review -> done, drop/reopen",
  );
  if (role === "admin") caps.push("manage actors and tokens");
  return caps;
}
