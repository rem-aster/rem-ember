/**
 * Compact markdown renderers. Agents read these; keep them dense and unambiguous.
 */
import type { ActorPublic, Comment, Event, Task } from "./types.js";

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

export function relAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function taskLine(t: Task): string {
  const bits = [`**${t.key}** [${t.status}] ${t.title}`, `prio:${t.priority}`, `kind:${t.kind}`];
  if (t.assignee) bits.push(`assignee:@${t.assignee}`);
  if (t.claim) bits.push(`held by @${t.claim.actor} (${t.claim.purpose}, until ${fmtTime(t.claim.expires_at)})`);
  if (t.labels.length) bits.push(`labels:${t.labels.join(",")}`);
  if (t.blocked_by.length) bits.push(`blocked_by:${t.blocked_by.join(",")}`);
  bits.push(`updated ${relAge(t.updated_at)}`);
  return "- " + bits.join(" | ");
}

export function taskDetail(t: Task, comments: Comment[], events?: Event[]): string {
  const lines: string[] = [];
  lines.push(`# ${t.key}: ${t.title}`);
  lines.push("");
  lines.push(`- status: **${t.status}** | priority: ${t.priority} | kind: ${t.kind}`);
  lines.push(`- reporter: @${t.reporter} (${t.source_channel}${t.source_author ? `, author: ${t.source_author}` : ""}${t.source_ref ? `, ref: ${t.source_ref}` : ""})`);
  lines.push(`- analyst: ${t.analyst ? "@" + t.analyst : "-"} | assignee: ${t.assignee ? "@" + t.assignee : "-"}`);
  if (t.claim) {
    lines.push(`- claim: @${t.claim.actor} for ${t.claim.purpose}, expires ${fmtTime(t.claim.expires_at)}${t.claim.note ? ` ("${t.claim.note}")` : ""}`);
  }
  if (t.labels.length) lines.push(`- labels: ${t.labels.join(", ")}`);
  if (t.blocked_by.length) lines.push(`- blocked_by: ${t.blocked_by.join(", ")}`);
  if (t.refs.length) lines.push(`- refs:\n${t.refs.map((r) => `  - ${r}`).join("\n")}`);
  lines.push(`- created ${fmtTime(t.created_at)} | updated ${fmtTime(t.updated_at)}${t.done_at ? ` | done ${fmtTime(t.done_at)}` : ""}`);
  lines.push("");
  lines.push("## Raw (original request, immutable)");
  lines.push(t.raw);
  section(lines, "Problem (refined statement)", t.problem);
  section(lines, "Analysis (technical)", t.analysis);
  section(lines, "Acceptance criteria", t.acceptance);
  if (comments.length) {
    lines.push("", `## Comments (${comments.length})`);
    for (const c of comments) lines.push(commentLine(c));
  }
  if (events && events.length) {
    lines.push("", `## Activity (${events.length})`);
    for (const e of events) lines.push(eventLine(e));
  }
  return lines.join("\n");
}

function section(lines: string[], title: string, body: string | null): void {
  lines.push("", `## ${title}`);
  lines.push(body && body.trim() ? body : "_(empty)_");
}

export function commentLine(c: Comment): string {
  const target = c.to_actor ? ` -> @${c.to_actor}` : c.to_role ? ` -> role:${c.to_role}` : "";
  const status = c.kind === "question" ? (c.resolved_at ? " (answered)" : " (OPEN)") : "";
  const reply = c.reply_to != null ? ` (re #${c.reply_to})` : "";
  return `- #${c.id} ${fmtTime(c.created_at)} @${c.actor} [${c.kind}${status}]${target}${reply}: ${c.body}`;
}

export function eventLine(e: Event): string {
  const data = { ...e.data };
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return `- ${fmtTime(e.created_at)} ${e.task_key ?? ""} @${e.actor} ${e.type}${parts.length ? " { " + parts.join(", ") + " }" : ""}`;
}

export function actorLine(a: ActorPublic, extra?: string): string {
  const bits = [`**@${a.handle}** ${a.display_name}`, `${a.kind}/${a.role}`];
  if (a.owner) bits.push(`owner:@${a.owner}`);
  if (a.context) bits.push(`context: ${a.context}`);
  if (!a.active) bits.push("INACTIVE");
  bits.push(`last seen ${a.last_seen_at ? relAge(a.last_seen_at) : "never"}`);
  if (extra) bits.push(extra);
  return "- " + bits.join(" | ");
}

export function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
