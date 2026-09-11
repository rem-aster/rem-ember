import { z } from "zod";
import { commentLine, json, taskDetail, taskLine } from "../format.js";
import { CLAIM_PURPOSES, COMMENT_KINDS, PRIORITIES, STATUSES, TASK_KINDS } from "../types.js";
import { TOOL_ROLES, allowedTransitions } from "../domain/workflow.js";
import { READ_ONLY, WRITE, WRITE_IDEMPOTENT, defineTool } from "./registry.js";

const TaskId = z.string().describe("Task key like 'T-42' (also accepts '42')");
const ResponseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' (default, compact) or 'json' (full structured data)");

export const createTask = defineTool({
  name: "ember_create_task",
  title: "Create task",
  description: `Creates a task in status "inbox" from a raw request: a feedback message pulled from Telegram, a manager's description, a bot report. Keep 'raw' verbatim (it is immutable) and put your own interpretation into 'problem'.

Idempotent ingestion: pass source_ref (e.g. "tg:-1001234:5678") and repeated calls with the same ref return the existing task instead of creating a duplicate (result.created=false).

Args: title (short, imperative), raw (original text verbatim), source_channel (telegram|manual|api|email|..., default manual), source_ref (unique external id, optional), source_author (external author name, optional), priority (low|normal|high|urgent, default normal), kind (bug|feature|chore|question|other, default other), labels (lowercase tags), problem (refined problem statement, optional).

Returns: { created: boolean, task }`,
  input: z.object({
    title: z.string().min(1).max(200),
    raw: z.string().min(1).max(20000).describe("Original request text, verbatim"),
    source_channel: z.string().max(40).optional(),
    source_ref: z.string().max(200).optional().describe("Unique external reference for deduplication"),
    source_author: z.string().max(120).optional(),
    priority: z.enum(PRIORITIES).optional(),
    kind: z.enum(TASK_KINDS).optional(),
    labels: z.array(z.string().max(40)).max(20).optional(),
    problem: z.string().max(20000).optional(),
  }),
  annotations: WRITE_IDEMPOTENT,
  roles: TOOL_ROLES.create_task,
  handler: (args, { actor, services }) => {
    const { task, created } = services.tasks.create(args, actor);
    const text = created
      ? `Created ${task.key} in inbox.\n${taskLine(task)}`
      : `Task with source_ref "${task.source_ref}" already exists: ${task.key} (not created again).\n${taskLine(task)}`;
    return { text, data: { created, task } };
  },
});

export const getTask = defineTool({
  name: "ember_get_task",
  title: "Get task",
  description: `Full task card: raw request, refined problem, technical analysis, acceptance criteria, refs (repo paths, MR/PR links, commits), labels, reporter/analyst/assignee, current claim (who holds it and until when), blockers, comments (including open questions) and optionally the activity log.

Args: task_id ("T-42"), include_events (default false), response_format.`,
  input: z.object({
    task_id: TaskId,
    include_events: z.boolean().default(false).describe("Append the activity log (who did what, when)"),
    response_format: ResponseFormat,
  }),
  annotations: READ_ONLY,
  roles: TOOL_ROLES.read,
  handler: ({ task_id, include_events, response_format }, { services }) => {
    const task = services.tasks.require(task_id);
    const comments = services.tasks.comments(task.id);
    const events = include_events ? services.tasks.events({ taskId: task.id, limit: 200 }).reverse() : undefined;
    const data = {
      task,
      comments,
      open_blockers: services.tasks.openBlockers(task),
      allowed_transitions: allowedTransitions(task.status),
      ...(events ? { events } : {}),
    };
    if (response_format === "json") return { text: json(data), data };
    return { text: taskDetail(task, comments, events), data };
  },
});

export const listTasks = defineTool({
  name: "ember_list_tasks",
  title: "List / search tasks",
  description: `Lists tasks with filters and pagination, ordered by priority then last update. By default closed tasks (done, dropped) are excluded unless you filter by status or set include_closed.

Args: status (array), assignee (@handle), claimed_by (@handle), reporter (@handle), label, priority, kind, query (words matched against title/raw/problem/analysis/acceptance/author, all must match), updated_since (ISO time), include_closed, limit (1-100, default 20), offset, response_format.

Returns: { total, count, offset, has_more, next_offset, tasks }`,
  input: z.object({
    status: z.array(z.enum(STATUSES)).optional(),
    assignee: z.string().optional(),
    claimed_by: z.string().optional(),
    reporter: z.string().optional(),
    label: z.string().optional(),
    priority: z.enum(PRIORITIES).optional(),
    kind: z.enum(TASK_KINDS).optional(),
    query: z.string().max(200).optional(),
    updated_since: z.string().datetime({ offset: true }).optional().describe("ISO 8601 timestamp"),
    include_closed: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
    response_format: ResponseFormat,
  }),
  annotations: READ_ONLY,
  roles: TOOL_ROLES.read,
  handler: ({ response_format, ...filters }, { services }) => {
    const { total, items } = services.tasks.list(filters);
    const hasMore = total > filters.offset + items.length;
    const data = {
      total,
      count: items.length,
      offset: filters.offset,
      has_more: hasMore,
      ...(hasMore ? { next_offset: filters.offset + items.length } : {}),
      tasks: items,
    };
    if (response_format === "json") return { text: json(data), data };
    const lines = [`# Tasks: ${total} match${items.length < total ? ` (showing ${filters.offset + 1}-${filters.offset + items.length})` : ""}`, ""];
    if (items.length === 0) lines.push("_No tasks match the filters._");
    for (const t of items) lines.push(taskLine(t));
    if (hasMore) lines.push("", `More available: offset=${filters.offset + items.length}`);
    return { text: lines.join("\n"), data };
  },
});

export const updateTask = defineTool({
  name: "ember_update_task",
  title: "Update task fields",
  description: `Edits task content. Only the fields you pass are changed; pass null to clear a text field. 'raw' and source fields are immutable.

Who may edit what: analysis, add_refs, remove_refs -> developer/admin (code context). title, problem, acceptance, priority, kind, labels, add_labels, remove_labels, assignee, blocked_by -> manager/developer/admin. Reporters comment instead.

Args: task_id, title, problem (refined problem statement: what/why/who is affected), analysis (technical: root cause, affected files/modules, proposed change, risks, estimate), acceptance (how to verify it is done), priority, kind, labels (replace), add_labels, remove_labels, add_refs (repo paths, branch names, MR/PR URLs, commit shas, log links), remove_refs, assignee (@handle or null), blocked_by (array of task keys, replace), note (why; goes to the activity log).`,
  input: z.object({
    task_id: TaskId,
    title: z.string().min(1).max(200).optional(),
    problem: z.string().max(20000).nullable().optional(),
    analysis: z.string().max(50000).nullable().optional(),
    acceptance: z.string().max(20000).nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    kind: z.enum(TASK_KINDS).optional(),
    labels: z.array(z.string().max(40)).max(20).optional(),
    add_labels: z.array(z.string().max(40)).max(20).optional(),
    remove_labels: z.array(z.string().max(40)).max(20).optional(),
    add_refs: z.array(z.string().max(500)).max(50).optional(),
    remove_refs: z.array(z.string().max(500)).max(50).optional(),
    assignee: z.string().nullable().optional(),
    blocked_by: z.array(z.string()).max(50).optional(),
    note: z.string().max(2000).optional(),
  }),
  annotations: WRITE_IDEMPOTENT,
  roles: TOOL_ROLES.update_task,
  handler: ({ task_id, ...patch }, { actor, services }) => {
    const task = services.tasks.update(task_id, patch, actor);
    return { text: `Updated ${task.key}.\n${taskLine(task)}`, data: { task } };
  },
});

export const claimTask = defineTool({
  name: "ember_claim_task",
  title: "Claim task (take a lease)",
  description: `Takes a time-limited lease on a task so other agents know you are on it. This is how work is pulled:
- purpose=analysis: from inbox (-> analysis). Developer/admin.
- purpose=implementation: from ready or review (-> in_progress), also resumes an unclaimed in_progress task. Sets you as assignee. Developer/admin.
- purpose=review: on a task in review (status unchanged). Developer/manager/admin; not your own task.

Re-claiming a task you already hold extends the lease (heartbeat). If someone else holds it you get a conflict naming the holder and expiry. Leases expire automatically (default TTL from server config) and the task returns to the pool. WIP limits apply (max claims per actor, optional per-status limits).

Args: task_id, purpose, ttl_minutes (optional), note (what exactly you are doing / where: branch, session), take_over (reassign a task assigned to someone else).`,
  input: z.object({
    task_id: TaskId,
    purpose: z.enum(CLAIM_PURPOSES),
    ttl_minutes: z.number().int().min(1).optional().describe("Lease length; re-claim to extend"),
    note: z.string().max(500).optional().describe("Short note: branch, session, approach"),
    take_over: z.boolean().default(false).describe("Reassign to yourself if assigned to someone else"),
  }),
  annotations: WRITE,
  roles: TOOL_ROLES.claim,
  handler: ({ task_id, ...opts }, { actor, services }) => {
    const { task, extended } = services.tasks.claim(task_id, actor, opts);
    const text = extended
      ? `Lease on ${task.key} extended until ${task.claim!.expires_at}.`
      : `Claimed ${task.key} for ${opts.purpose}; status is now "${task.status}", lease until ${task.claim!.expires_at}.\n${taskLine(task)}`;
    return { text, data: { extended, task } };
  },
});

export const releaseTask = defineTool({
  name: "ember_release_task",
  title: "Release task lease",
  description: `Drops your lease on a task without finishing it (session ending, switching work, blocked). Status reverts to the pool state (analysis -> inbox, in_progress -> ready, review stays). You stay assignee unless unassign=true, so you can resume later via ember_my_work. Managers/admins can release someone else's lease with a note.

Args: task_id, note (why / where you stopped), unassign (default false).`,
  input: z.object({
    task_id: TaskId,
    note: z.string().max(2000).optional(),
    unassign: z.boolean().default(false),
  }),
  annotations: WRITE_IDEMPOTENT,
  roles: TOOL_ROLES.claim,
  handler: ({ task_id, ...opts }, { actor, services }) => {
    const task = services.tasks.release(task_id, actor, opts);
    return { text: `Released ${task.key}; status is now "${task.status}".\n${taskLine(task)}`, data: { task } };
  },
});

export const transitionTask = defineTool({
  name: "ember_transition_task",
  title: "Change task status",
  description: `Moves a task along the flow. Pulling work (inbox->analysis, ready->in_progress) is done with ember_claim_task, not here. Available here:
- analysis -> ready (claim holder; requires task.analysis to be written)
- inbox -> ready (developer; skip analysis phase if analysis already written)
- in_progress -> review (claim holder; add MR/PR refs first)
- review -> done (developer/manager; the verifier)
- review -> ready (rework; note required)
- in_progress -> ready (give back to pool; note required)
- ready -> inbox (needs more analysis; note required)
- any open -> dropped (note required); dropped -> inbox; done -> ready/inbox (reopen; note required)

The error message lists the allowed targets if the move is not possible.

Args: task_id, to (status), note (required for some moves; always welcome).`,
  input: z.object({
    task_id: TaskId,
    to: z.enum(STATUSES),
    note: z.string().max(2000).optional(),
  }),
  annotations: WRITE,
  roles: TOOL_ROLES.transition,
  handler: ({ task_id, to, note }, { actor, services }) => {
    const before = services.tasks.require(task_id).status;
    const task = services.tasks.transition(task_id, to, actor, note);
    return { text: `${task.key}: ${before} -> ${task.status}.\n${taskLine(task)}`, data: { from: before, task } };
  },
});

export const commentTask = defineTool({
  name: "ember_comment_task",
  title: "Comment / ask / answer / decide",
  description: `Adds a comment to a task. This is the channel for collaboration between actors with different context (code vs management):
- kind=comment: plain note.
- kind=question: needs an answer; address it with to=@handle or to=role:manager|developer|admin|reporter. Open questions appear in the addressee's ember_my_work and ember_whoami.
- kind=answer: reply_to=<question comment id>; marks the question resolved.
- kind=decision: a decision that others should respect (scope cut, priority call, approach chosen).

Args: task_id, body, kind (default comment), to (handle or role:xxx), reply_to (comment id).`,
  input: z.object({
    task_id: TaskId,
    body: z.string().min(1).max(20000),
    kind: z.enum(COMMENT_KINDS).default("comment"),
    to: z.string().optional().describe("@handle or role:<role> for questions"),
    reply_to: z.number().int().positive().optional().describe("Comment id being answered"),
  }),
  annotations: WRITE,
  roles: TOOL_ROLES.comment,
  handler: ({ task_id, ...input }, { actor, services }) => {
    const comment = services.tasks.comment(task_id, input, actor);
    return { text: `Added ${comment.kind} #${comment.id} to ${comment.task_key}.\n${commentLine(comment)}`, data: { comment } };
  },
});

export const taskTools = [createTask, getTask, listTasks, updateTask, claimTask, releaseTask, transitionTask, commentTask];
