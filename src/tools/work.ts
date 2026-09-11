import { z } from "zod";
import { eventLine, fmtTime, json, taskLine } from "../format.js";
import { TOOL_ROLES } from "../domain/workflow.js";
import { READ_ONLY, defineTool } from "./registry.js";

const ResponseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' (default, compact) or 'json' (full structured data)");

export const myWork = defineTool({
  name: "ember_my_work",
  title: "My work (pull queue)",
  description: `What you should look at now, tailored to your role: your active leases (with minutes left), tasks assigned to you that are not claimed (resume them), open questions addressed to you or your role, and pull queues:
- developer: analysis (inbox tasks nobody holds), implementation (ready, unblocked, unassigned or yours), review (in review, not yours)
- manager: triage (inbox without a refined problem statement), verify (in review, unclaimed)
- reporter: your open reported tasks

Queues are ordered by priority then age (oldest first). Pull from the right: finish/verify before starting new work.`,
  input: z.object({ response_format: ResponseFormat }),
  annotations: READ_ONLY,
  roles: TOOL_ROLES.read,
  handler: ({ response_format }, { actor, services }) => {
    const work = services.tasks.myWork(actor);
    const data = work as unknown as Record<string, unknown>;
    if (response_format === "json") return { text: json(work), data };
    const lines = [`# Work for @${work.actor} (${work.role}) - WIP ${work.wip.claims}/${work.wip.max_claims}`];
    lines.push("", "## Your active claims");
    if (!work.claims.length) lines.push("_none_");
    for (const c of work.claims) lines.push(`- ${c.task.key} [${c.task.status}] ${c.task.title} | ${c.purpose} | ${c.minutes_left} min left (until ${fmtTime(c.expires_at)})`);
    if (work.assigned_not_claimed.length) {
      lines.push("", "## Assigned to you, not claimed (resume with ember_claim_task)");
      for (const t of work.assigned_not_claimed) lines.push(taskLine(t));
    }
    lines.push("", `## Open questions for you (${work.questions_for_me.length})`);
    if (!work.questions_for_me.length) lines.push("_none_");
    for (const q of work.questions_for_me) {
      lines.push(`- ${q.task_key} "${q.task_title}" #${q.comment_id} from @${q.from}${q.to_role ? ` (to role:${q.to_role})` : ""}: ${q.body}`);
    }
    for (const [name, items] of Object.entries(work.pull)) {
      lines.push("", `## Pull: ${name} (${items.length})`);
      if (!items.length) lines.push("_empty_");
      for (const t of items) lines.push(taskLine(t));
    }
    return { text: lines.join("\n"), data };
  },
});

export const board = defineTool({
  name: "ember_board",
  title: "Board summary",
  description: `Bird's-eye view of the flow: counts per status, WIP limits, oldest item per status (age in hours), active claims (who holds what until when), tasks stalled in analysis/in_progress without a claim, open questions, and urgent/high open tasks. Use it for stand-ups, to spot bottlenecks, or before pulling work.`,
  input: z.object({ response_format: ResponseFormat }),
  annotations: READ_ONLY,
  roles: TOOL_ROLES.read,
  handler: ({ response_format }, { services }) => {
    const b = services.tasks.board();
    const data = b as unknown as Record<string, unknown>;
    if (response_format === "json") return { text: json(b), data };
    const lines = ["# Board", ""];
    lines.push(
      "| " + Object.keys(b.counts).join(" | ") + " |",
      "|" + Object.keys(b.counts).map(() => "---").join("|") + "|",
      "| " + Object.values(b.counts).join(" | ") + " |",
    );
    lines.push("", `Open: ${b.open_total} | Closed: ${b.closed_total} | Done in last 7 days: ${b.done_last_7d}`);
    lines.push(`WIP limits: ${b.wip_limits.per_actor_claims} claims per actor${Object.keys(b.wip_limits.per_status).length ? ", per status: " + JSON.stringify(b.wip_limits.per_status) : ""}`);
    const oldest = Object.entries(b.oldest_per_status).map(([s, o]) => `${s}: ${o.key} (${o.age_hours}h)`);
    if (oldest.length) lines.push(`Oldest per status: ${oldest.join("; ")}`);
    lines.push("", `## Active claims (${b.active_claims.length})`);
    if (!b.active_claims.length) lines.push("_none_");
    for (const c of b.active_claims) lines.push(`- ${c.key} [${c.status}] ${c.title} | @${c.holder} ${c.purpose} until ${fmtTime(c.expires_at)}${c.note ? ` ("${c.note}")` : ""}`);
    if (b.stalled_without_claim.length) {
      lines.push("", `## Stalled without a claim (${b.stalled_without_claim.length})`);
      for (const t of b.stalled_without_claim) lines.push(`- ${t.key} [${t.status}] ${t.title}${t.assignee ? ` | assignee @${t.assignee}` : ""} | updated ${fmtTime(t.updated_at)}`);
    }
    lines.push("", `## Open questions (${b.open_questions.length})`);
    if (!b.open_questions.length) lines.push("_none_");
    for (const q of b.open_questions) lines.push(`- ${q.task_key} #${q.comment_id} @${q.from} -> ${q.to_actor ? "@" + q.to_actor : q.to_role ? "role:" + q.to_role : "anyone"}: ${q.body}`);
    if (b.urgent_open.length) {
      lines.push("", `## Urgent / high (${b.urgent_open.length})`);
      for (const t of b.urgent_open) lines.push(`- ${t.key} [${t.status}] ${t.priority} ${t.title}${t.assignee ? ` | @${t.assignee}` : ""}`);
    }
    return { text: lines.join("\n"), data };
  },
});

export const activity = defineTool({
  name: "ember_activity",
  title: "Activity log",
  description: `Chronological log of who did what: task created/updated/claimed/released/expired, status changes, comments, questions, answers, actor changes. Use since=<ISO time> to catch up on what happened while you were away, task_id to audit one task, actor to see what a colleague or agent did.

Args: task_id, actor (@handle), since (ISO 8601), limit (1-200, default 50), response_format. Newest first.`,
  input: z.object({
    task_id: z.string().optional(),
    actor: z.string().optional(),
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    response_format: ResponseFormat,
  }),
  annotations: READ_ONLY,
  roles: TOOL_ROLES.read,
  handler: ({ task_id, actor, since, limit, response_format }, { services }) => {
    const taskId = task_id ? services.tasks.require(task_id).id : undefined;
    const actorId = actor ? services.actors.require(actor).id : undefined;
    const events = services.tasks.events({ taskId, actorId, since, limit });
    const data = { count: events.length, events };
    if (response_format === "json") return { text: json(data), data };
    const lines = [`# Activity (${events.length}${since ? `, since ${fmtTime(since)}` : ""})`, ""];
    if (!events.length) lines.push("_nothing yet_");
    for (const e of events) lines.push(eventLine(e));
    return { text: lines.join("\n"), data };
  },
});

export const workTools = [myWork, board, activity];
