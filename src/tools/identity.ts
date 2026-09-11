import { z } from "zod";
import { actorLine, fmtTime, json } from "../format.js";
import { forbidden } from "../errors.js";
import { ACTOR_KINDS, ROLES } from "../types.js";
import { ROLE_DESCRIPTIONS, TOOL_ROLES, capabilitiesFor } from "../domain/workflow.js";
import { READ_ONLY, WRITE, WRITE_IDEMPOTENT, defineTool } from "./registry.js";

const ResponseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' (default, compact) or 'json' (full structured data). structuredContent is always JSON.");

export const FLOW_CHEATSHEET = [
  "Flow: inbox -> analysis -> ready -> in_progress -> review -> done (or dropped at any point).",
  "inbox: raw request landed (from Telegram/feedback or a manager). Developer pulls it with ember_claim_task purpose=analysis.",
  "analysis: developer studies the code, writes task.analysis (root cause, affected files, plan) via ember_update_task, then ember_transition_task to=ready.",
  "ready: pull with ember_claim_task purpose=implementation (sets you as assignee). Work, add MR/PR links via add_refs, then ember_transition_task to=review.",
  "review: another developer/manager claims purpose=review (optional) and moves to done, or back to ready with a note.",
  "Claims are leases with a TTL: re-claim to extend, ember_release_task when you stop. Expired leases revert the task to the pool automatically.",
  "Ask across contexts with ember_comment_task kind=question to=@handle or to=role:manager; answer with kind=answer reply_to=<comment id>.",
  "Start every session with ember_whoami, then ember_my_work to see what to pull.",
];

export const whoami = defineTool({
  name: "ember_whoami",
  title: "Who am I",
  description: `Returns the identity behind the current token: handle, display name, kind (human/agent/bot), role, owner (for agents), context, capabilities, current claims, tasks assigned to you and open questions addressed to you. Also returns the server time and a short cheat-sheet of the workflow.

Call this first in every session. Identity is derived from the bearer token, never from arguments; use the returned handle when referring to yourself.

Returns (json): { actor, capabilities, claims, assigned_not_claimed, questions_for_me, server_time, flow }`,
  input: z.object({ response_format: ResponseFormat }),
  annotations: READ_ONLY,
  roles: TOOL_ROLES.read,
  handler: ({ response_format }, { actor, services }) => {
    const pub = services.actors.toPublic(actor);
    const work = services.tasks.myWork(actor);
    const data = {
      actor: pub,
      role_description: ROLE_DESCRIPTIONS[actor.role],
      capabilities: capabilitiesFor(actor.role),
      wip: work.wip,
      claims: work.claims.map((c) => ({ task: c.task.key, title: c.task.title, purpose: c.purpose, expires_at: c.expires_at, minutes_left: c.minutes_left })),
      assigned_not_claimed: work.assigned_not_claimed.map((t) => ({ task: t.key, title: t.title, status: t.status })),
      questions_for_me: work.questions_for_me,
      server_time: new Date().toISOString(),
      flow: FLOW_CHEATSHEET,
    };
    if (response_format === "json") return { text: json(data), data };
    const lines = [
      `You are **@${pub.handle}** (${pub.display_name}), ${pub.kind} with role **${pub.role}**${pub.owner ? `, acting for @${pub.owner}` : ""}.`,
      pub.context ? `Context: ${pub.context}` : "Context: (not set)",
      `Role: ${ROLE_DESCRIPTIONS[actor.role]}`,
      `Capabilities: ${data.capabilities.join("; ")}.`,
      `WIP: ${work.wip.claims}/${work.wip.max_claims} claims.`,
    ];
    if (data.claims.length) {
      lines.push("", "Your active claims:");
      for (const c of data.claims) lines.push(`- ${c.task} ${c.title} (${c.purpose}, ${c.minutes_left} min left)`);
    }
    if (data.assigned_not_claimed.length) {
      lines.push("", "Assigned to you, not claimed right now:");
      for (const t of data.assigned_not_claimed) lines.push(`- ${t.task} [${t.status}] ${t.title}`);
    }
    if (data.questions_for_me.length) {
      lines.push("", "Open questions for you:");
      for (const q of data.questions_for_me) lines.push(`- ${q.task_key} #${q.comment_id} from @${q.from}: ${q.body}`);
    }
    lines.push("", `Server time: ${fmtTime(data.server_time)}`, "", "Workflow:", ...FLOW_CHEATSHEET.map((l) => `- ${l}`));
    return { text: lines.join("\n"), data };
  },
});

export const listActors = defineTool({
  name: "ember_list_actors",
  title: "List actors (who is who)",
  description: `Directory of everyone who can touch the tracker: humans, their agents and bots. For each actor: handle, display name, kind, role, owner (which human an agent acts for), context (what they know / have access to), last seen, current claims (what they are working on right now) and number of open tasks assigned.

Use it to find whom to ask a question (to=@handle) or who holds a task.

Args: role (filter), kind (filter), include_inactive (default false), response_format.`,
  input: z.object({
    role: z.enum(ROLES).optional().describe("Only actors with this role"),
    kind: z.enum(ACTOR_KINDS).optional().describe("Only actors of this kind"),
    include_inactive: z.boolean().default(false).describe("Include deactivated actors"),
    response_format: ResponseFormat,
  }),
  annotations: READ_ONLY,
  roles: TOOL_ROLES.read,
  handler: ({ role, kind, include_inactive, response_format }, { services }) => {
    const actors = services.actors.list({ role, kind, include_inactive });
    const items = actors.map((a) => {
      const claims = services.tasks.claimsOf(a).map((t) => ({ task: t.key, purpose: t.claim!.purpose, expires_at: t.claim!.expires_at }));
      const assigned = services.tasks.list({ assignee: a.handle, limit: 100, offset: 0 }).total;
      return { ...services.actors.toPublic(a), claims, assigned_open: assigned };
    });
    const data = { count: items.length, actors: items };
    if (response_format === "json") return { text: json(data), data };
    const lines = [`# Actors (${items.length})`, ""];
    for (const a of items) {
      const extra = a.claims.length
        ? `working on: ${a.claims.map((c) => `${c.task} (${c.purpose})`).join(", ")}`
        : `assigned open: ${a.assigned_open}`;
      lines.push(actorLine(a, extra));
    }
    return { text: lines.join("\n"), data };
  },
});

export const createActor = defineTool({
  name: "ember_create_actor",
  title: "Create actor (admin)",
  description: `Registers a new actor and issues its bearer token. Admin only. The token is returned ONCE in this response; store it in the client's MCP config (Authorization: Bearer ...). Each agent should get its own actor (kind=agent, owner=@human) so that the activity log shows who did what.

Args: handle (unique, lowercase, e.g. "petya" or "petya-claude"), display_name, kind (human|agent|bot), role (admin|manager|developer|reporter), owner (handle of the responsible human, for agents/bots), context (free text: what this actor knows or has access to, e.g. "Claude Code with the backend repo"), issue_token (default true; false for a human who acts only through agents).`,
  input: z.object({
    handle: z.string().min(2).max(33).describe("Unique handle, e.g. 'petya' or 'petya-claude'"),
    display_name: z.string().min(1).max(120),
    kind: z.enum(ACTOR_KINDS),
    role: z.enum(ROLES),
    owner: z.string().optional().describe("Handle of the human this agent/bot acts for"),
    context: z.string().max(2000).optional().describe("What this actor knows / has access to"),
    issue_token: z.boolean().default(true),
  }),
  annotations: WRITE,
  roles: TOOL_ROLES.admin,
  handler: (args, { actor, services }) => {
    const { actor: created, token } = services.actors.create(args, actor);
    const pub = services.actors.toPublic(created);
    const data = { actor: pub, token };
    const text = [
      `Created @${pub.handle} (${pub.display_name}) as ${pub.kind}/${pub.role}${pub.owner ? `, owner @${pub.owner}` : ""}.`,
      token ? `Token (shown once): ${token}` : "No token issued.",
    ].join("\n");
    return { text, data };
  },
});

export const updateActor = defineTool({
  name: "ember_update_actor",
  title: "Update actor (admin)",
  description: `Changes an actor's display name, role, kind, owner, context or active flag. Admin only. Deactivating an actor immediately invalidates its token for new requests (active=false); reactivate with active=true.

Args: handle (required) plus any of display_name, role, kind, owner (handle or null), context (text or null), active (boolean).`,
  input: z.object({
    handle: z.string(),
    display_name: z.string().min(1).max(120).optional(),
    role: z.enum(ROLES).optional(),
    kind: z.enum(ACTOR_KINDS).optional(),
    owner: z.string().nullable().optional(),
    context: z.string().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  }),
  annotations: WRITE_IDEMPOTENT,
  roles: TOOL_ROLES.admin,
  handler: ({ handle, ...patch }, { actor, services }) => {
    const updated = services.actors.update(handle, patch, actor);
    const pub = services.actors.toPublic(updated);
    return { text: `Updated @${pub.handle}.\n${actorLine(pub)}`, data: { actor: pub } };
  },
});

export const rotateToken = defineTool({
  name: "ember_rotate_actor_token",
  title: "Rotate token",
  description: `Issues a new bearer token and invalidates the old one. Anyone can rotate their own token (omit handle); admins can rotate anyone's. The new token is returned once.

Args: handle (optional; defaults to yourself).`,
  input: z.object({ handle: z.string().optional().describe("Whose token to rotate; defaults to yourself") }),
  annotations: WRITE,
  roles: TOOL_ROLES.read,
  handler: ({ handle }, { actor, services }) => {
    const target = handle ? services.actors.require(handle) : actor;
    if (target.id !== actor.id && actor.role !== "admin") {
      throw forbidden("Only admins can rotate someone else's token");
    }
    const { token } = services.actors.rotateToken(target.handle, actor);
    return {
      text: `Rotated token for @${target.handle}. New token (shown once): ${token}\nUpdate the client config now; the old token no longer works.`,
      data: { handle: target.handle, token },
    };
  },
});

export const identityTools = [whoami, listActors, createActor, updateActor, rotateToken];
