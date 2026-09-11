/**
 * Domain types shared by storage, domain logic, tools and the CLI.
 */

export const ROLES = ["admin", "manager", "developer", "reporter"] as const;
export type Role = (typeof ROLES)[number];

export const ACTOR_KINDS = ["human", "agent", "bot"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const STATUSES = [
  "inbox",
  "analysis",
  "ready",
  "in_progress",
  "review",
  "done",
  "dropped",
] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_KINDS = ["bug", "feature", "chore", "question", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const CLAIM_PURPOSES = ["analysis", "implementation", "review"] as const;
export type ClaimPurpose = (typeof CLAIM_PURPOSES)[number];

export const COMMENT_KINDS = ["comment", "question", "answer", "decision"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export interface Actor {
  id: number;
  handle: string;
  display_name: string;
  kind: ActorKind;
  role: Role;
  owner_id: number | null;
  context: string | null;
  has_token: boolean;
  active: boolean;
  created_at: string;
  last_seen_at: string | null;
}

/** Actor as shown to other actors (never includes secrets). */
export interface ActorPublic {
  id: number;
  handle: string;
  display_name: string;
  kind: ActorKind;
  role: Role;
  owner: string | null;
  context: string | null;
  active: boolean;
  last_seen_at: string | null;
}

export interface Claim {
  actor: string;
  purpose: ClaimPurpose;
  note: string | null;
  claimed_at: string;
  expires_at: string;
}

export interface Task {
  id: number;
  key: string; // "T-42"
  title: string;
  status: Status;
  priority: Priority;
  kind: TaskKind;
  raw: string;
  problem: string | null;
  analysis: string | null;
  acceptance: string | null;
  labels: string[];
  refs: string[];
  source_channel: string;
  source_ref: string | null;
  source_author: string | null;
  reporter: string;
  analyst: string | null;
  assignee: string | null;
  claim: Claim | null;
  blocked_by: string[];
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

export interface Comment {
  id: number;
  task_key: string;
  actor: string;
  kind: CommentKind;
  body: string;
  to_actor: string | null;
  to_role: Role | null;
  reply_to: number | null;
  resolved_at: string | null;
  created_at: string;
}

export interface Event {
  id: number;
  task_key: string | null;
  actor: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}
