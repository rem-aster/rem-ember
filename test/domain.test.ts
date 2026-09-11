import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EmberError } from "../src/errors.js";
import { normalizeHandle, parseTaskKey } from "../src/ids.js";
import { makeWorld, newTask } from "./helpers.js";

function fails(fn: () => unknown, code: string): EmberError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof EmberError, `expected EmberError, got ${String(e)}`);
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected error ${code}`);
}

describe("ids", () => {
  it("parses task keys leniently", () => {
    for (const k of ["T-42", "t-42", "t42", "#42", "42", " T-42 "]) assert.equal(parseTaskKey(k), 42);
    fails(() => parseTaskKey("abc"), "invalid");
    fails(() => parseTaskKey("0"), "invalid");
  });
  it("normalizes handles", () => {
    assert.equal(normalizeHandle("@Petya-Claude"), "petya-claude");
    fails(() => normalizeHandle("x"), "invalid");
    fails(() => normalizeHandle("with space"), "invalid");
  });
});

describe("actors & tokens", () => {
  it("authenticates by token only and tracks last_seen", () => {
    const w = makeWorld();
    const a = w.services.actors.authenticate(w.tokens["petya-claude"]!);
    assert.equal(a?.handle, "petya-claude");
    assert.ok(a?.last_seen_at === null || typeof a?.last_seen_at === "string");
    assert.equal(w.services.actors.authenticate("ember_nope"), undefined);
  });
  it("rejects duplicate handles", () => {
    const w = makeWorld();
    fails(() => w.services.actors.create({ handle: "admin", display_name: "x", kind: "human", role: "admin" }, w.admin), "conflict");
  });
  it("rotation invalidates the old token; deactivation blocks auth", () => {
    const w = makeWorld();
    const old = w.tokens["tg-bot"]!;
    const { token } = w.services.actors.rotateToken("tg-bot", w.admin);
    assert.equal(w.services.actors.authenticate(old), undefined);
    assert.equal(w.services.actors.authenticate(token)?.handle, "tg-bot");
    w.services.actors.update("tg-bot", { active: false }, w.admin);
    assert.equal(w.services.actors.authenticate(token), undefined);
    w.services.actors.update("tg-bot", { active: true }, w.admin);
    assert.equal(w.services.actors.authenticate(token)?.handle, "tg-bot");
  });
  it("admins cannot demote or deactivate themselves", () => {
    const w = makeWorld();
    fails(() => w.services.actors.update("admin", { active: false }, w.admin), "forbidden");
    fails(() => w.services.actors.update("admin", { role: "manager" }, w.admin), "forbidden");
  });
  it("shows owner in public view", () => {
    const w = makeWorld();
    const { actor } = w.services.actors.create({ handle: "bot2", display_name: "b", kind: "bot", role: "reporter", owner: "@admin" }, w.admin);
    assert.equal(w.services.actors.toPublic(actor).owner, "admin");
  });
});

describe("task creation", () => {
  it("lands in inbox and dedups by source_ref", () => {
    const w = makeWorld();
    const a = w.services.tasks.create({ title: "A", raw: "a", source_ref: "tg:1:1" }, w.bot);
    const b = w.services.tasks.create({ title: "B", raw: "b", source_ref: "tg:1:1" }, w.bot);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.task.key, b.task.key);
    assert.equal(a.task.status, "inbox");
    assert.equal(a.task.key, "T-1");
  });
  it("search matches terms across fields", () => {
    const w = makeWorld();
    newTask(w, "Export hangs on big CSV");
    newTask(w, "Dark theme");
    assert.equal(w.services.tasks.list({ query: "csv export", limit: 10, offset: 0 }).total, 1);
    assert.equal(w.services.tasks.list({ query: "100%", limit: 10, offset: 0 }).total, 0);
    assert.equal(w.services.tasks.list({ limit: 1, offset: 0 }).items.length, 1);
  });
});

describe("field permissions", () => {
  it("reporter cannot edit, manager cannot write analysis, developer can", () => {
    const w = makeWorld();
    const t = newTask(w);
    fails(() => w.services.tasks.update(t.key, { priority: "high" }, w.bot), "forbidden");
    fails(() => w.services.tasks.update(t.key, { analysis: "x" }, w.manager), "forbidden");
    const u = w.services.tasks.update(t.key, { problem: "p", priority: "high", add_labels: ["Perf", "perf"] }, w.manager);
    assert.equal(u.priority, "high");
    assert.deepEqual(u.labels, ["perf"]);
    const d = w.services.tasks.update(t.key, { analysis: "root cause", add_refs: ["a.ts"] }, w.dev);
    assert.equal(d.analysis, "root cause");
    assert.deepEqual(d.refs, ["a.ts"]);
  });
  it("cannot assign a reporter or block on itself", () => {
    const w = makeWorld();
    const t = newTask(w);
    fails(() => w.services.tasks.update(t.key, { assignee: "tg-bot" }, w.manager), "invalid");
    fails(() => w.services.tasks.update(t.key, { blocked_by: [t.key] }, w.manager), "invalid");
    fails(() => w.services.tasks.update(t.key, { blocked_by: ["T-99"] }, w.manager), "not_found");
  });
});

describe("claims (leases)", () => {
  it("analysis claim moves inbox->analysis; ready requires analysis text", () => {
    const w = makeWorld();
    const t = newTask(w);
    fails(() => w.services.tasks.claim(t.key, w.manager, { purpose: "analysis" }), "forbidden");
    const { task } = w.services.tasks.claim(t.key, w.dev, { purpose: "analysis" });
    assert.equal(task.status, "analysis");
    assert.equal(task.claim?.actor, "petya-claude");
    fails(() => w.services.tasks.transition(t.key, "ready", w.dev), "conflict");
    w.services.tasks.update(t.key, { analysis: "done" }, w.dev);
    const ready = w.services.tasks.transition(t.key, "ready", w.dev);
    assert.equal(ready.status, "ready");
    assert.equal(ready.analyst, "petya-claude");
    assert.equal(ready.claim, null);
  });
  it("conflicts name the holder; same holder extends", () => {
    const w = makeWorld();
    const t = newTask(w);
    const first = w.services.tasks.claim(t.key, w.dev, { purpose: "analysis", ttl_minutes: 10 });
    const e = fails(() => w.services.tasks.claim(t.key, w.dev2, { purpose: "analysis" }), "conflict");
    assert.equal(e.details?.holder, "petya-claude");
    const again = w.services.tasks.claim(t.key, w.dev, { purpose: "analysis", ttl_minutes: 120 });
    assert.equal(again.extended, true);
    assert.ok(again.task.claim!.expires_at > first.task.claim!.expires_at);
    fails(() => w.services.tasks.claim(t.key, w.dev, { purpose: "implementation" }), "conflict");
  });
  it("enforces per-actor WIP limit", () => {
    const w = makeWorld({ maxClaimsPerActor: 1 });
    const a = newTask(w, "a");
    const b = newTask(w, "b");
    w.services.tasks.claim(a.key, w.dev, { purpose: "analysis" });
    const e = fails(() => w.services.tasks.claim(b.key, w.dev, { purpose: "analysis" }), "wip_limit");
    assert.deepEqual(e.details?.claims, [a.key]);
  });
  it("enforces per-status WIP limit", () => {
    const w = makeWorld({ wipLimits: { analysis: 1 } });
    const a = newTask(w, "a");
    const b = newTask(w, "b");
    w.services.tasks.claim(a.key, w.dev, { purpose: "analysis" });
    fails(() => w.services.tasks.claim(b.key, w.dev2, { purpose: "analysis" }), "wip_limit");
  });
  it("release reverts status and keeps assignee unless unassign", () => {
    const w = makeWorld();
    const t = newTask(w);
    w.services.tasks.update(t.key, { analysis: "x" }, w.dev);
    w.services.tasks.transition(t.key, "ready", w.dev);
    w.services.tasks.claim(t.key, w.dev, { purpose: "implementation" });
    fails(() => w.services.tasks.release(t.key, w.dev2), "forbidden");
    fails(() => w.services.tasks.release(t.key, w.manager), "invalid"); // note required
    const r = w.services.tasks.release(t.key, w.dev, { note: "eod" });
    assert.equal(r.status, "ready");
    assert.equal(r.assignee, "petya-claude");
    assert.equal(r.claim, null);
    const work = w.services.tasks.myWork(w.dev);
    assert.equal(work.assigned_not_claimed[0]?.key, t.key);
    w.services.tasks.claim(t.key, w.dev, { purpose: "implementation" });
    assert.equal(w.services.tasks.release(t.key, w.dev, { unassign: true }).assignee, null);
  });
  it("expired leases are swept back to the pool", () => {
    const w = makeWorld();
    const t = newTask(w);
    w.services.tasks.claim(t.key, w.dev, { purpose: "analysis" });
    w.db.run("UPDATE tasks SET claim_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", t.id);
    assert.equal(w.services.tasks.sweepExpiredClaims(), 1);
    const after = w.services.tasks.byKey(t.key)!;
    assert.equal(after.status, "inbox");
    assert.equal(after.claim, null);
    assert.equal(w.services.tasks.events({ taskId: t.id, limit: 1 })[0]?.type, "task.claim_expired");
    assert.equal(w.services.tasks.sweepExpiredClaims(), 0);
  });
  it("implementation claim respects assignee (take_over) and blockers", () => {
    const w = makeWorld();
    const blocker = newTask(w, "blocker");
    const t = newTask(w);
    w.services.tasks.update(t.key, { analysis: "x", assignee: "kolya-claude", blocked_by: [blocker.key] }, w.dev);
    w.services.tasks.transition(t.key, "ready", w.dev);
    fails(() => w.services.tasks.claim(t.key, w.dev, { purpose: "implementation" }), "conflict"); // assigned to kolya
    const e = fails(() => w.services.tasks.claim(t.key, w.dev, { purpose: "implementation", take_over: true }), "conflict"); // blocked
    assert.deepEqual(e.details?.blocked_by, [blocker.key]);
    w.services.tasks.transition(blocker.key, "dropped", w.manager, "obsolete");
    const c = w.services.tasks.claim(t.key, w.dev, { purpose: "implementation", take_over: true });
    assert.equal(c.task.status, "in_progress");
    assert.equal(c.task.assignee, "petya-claude");
    assert.equal(w.services.tasks.events({ taskId: t.id, limit: 1 })[0]?.data.reassigned_from, "kolya-claude");
  });
});

describe("review & completion", () => {
  function toReview(w: ReturnType<typeof makeWorld>) {
    const t = newTask(w);
    w.services.tasks.update(t.key, { analysis: "x" }, w.dev);
    w.services.tasks.transition(t.key, "ready", w.dev);
    w.services.tasks.claim(t.key, w.dev, { purpose: "implementation" });
    fails(() => w.services.tasks.transition(t.key, "review", w.dev2), "forbidden"); // not holder
    return w.services.tasks.transition(t.key, "review", w.dev);
  }
  it("implementer cannot review own task; manager verifies and marks done", () => {
    const w = makeWorld();
    const t = toReview(w);
    assert.equal(t.status, "review");
    assert.equal(t.claim, null);
    fails(() => w.services.tasks.claim(t.key, w.dev, { purpose: "review" }), "conflict");
    const r = w.services.tasks.claim(t.key, w.manager, { purpose: "review" });
    assert.equal(r.task.status, "review");
    assert.equal(r.task.assignee, "petya-claude");
    assert.equal(w.services.tasks.events({ taskId: t.id, limit: 1 })[0]?.data.reassigned_from, undefined);
    fails(() => w.services.tasks.transition(t.key, "done", w.dev2), "conflict"); // manager holds review claim
    const done = w.services.tasks.transition(t.key, "done", w.manager, "verified");
    assert.equal(done.status, "done");
    assert.ok(done.done_at);
    assert.equal(done.claim, null);
    assert.equal(w.services.tasks.board().counts.done, 1);
  });
  it("rework: review -> ready keeps assignee; re-claim from review goes to in_progress", () => {
    const w = makeWorld();
    const t = toReview(w);
    fails(() => w.services.tasks.transition(t.key, "ready", w.dev2), "invalid"); // note required
    const back = w.services.tasks.transition(t.key, "ready", w.dev2, "tests missing");
    assert.equal(back.assignee, "petya-claude");
    w.services.tasks.claim(t.key, w.dev, { purpose: "implementation" });
    w.services.tasks.transition(t.key, "review", w.dev);
    const re = w.services.tasks.claim(t.key, w.dev, { purpose: "implementation" });
    assert.equal(re.task.status, "in_progress");
  });
  it("illegal transitions explain the allowed ones", () => {
    const w = makeWorld();
    const t = newTask(w);
    const e = fails(() => w.services.tasks.transition(t.key, "done", w.dev), "conflict");
    assert.match(e.hint ?? "", /ready, dropped/);
    fails(() => w.services.tasks.transition(t.key, "dropped", w.dev), "invalid"); // note required
    fails(() => w.services.tasks.transition(t.key, "dropped", w.bot, "x"), "forbidden");
    const d = w.services.tasks.transition(t.key, "dropped", w.manager, "duplicate");
    assert.equal(d.status, "dropped");
    assert.equal(w.services.tasks.transition(t.key, "inbox", w.manager, "reopen").status, "inbox");
  });
});

describe("questions", () => {
  it("routes questions by handle or role and resolves on answer", () => {
    const w = makeWorld();
    const t = newTask(w);
    const q1 = w.services.tasks.comment(t.key, { body: "which client?", kind: "question", to: "@masha-claude" }, w.dev);
    const q2 = w.services.tasks.comment(t.key, { body: "any dev?", kind: "question", to: "role:developer" }, w.manager);
    fails(() => w.services.tasks.comment(t.key, { body: "x", kind: "question", to: "role:ceo" }, w.dev), "invalid");
    fails(() => w.services.tasks.comment(t.key, { body: "x", kind: "answer" }, w.dev), "invalid");
    assert.deepEqual(w.services.tasks.openQuestions({ forActor: w.manager }).map((q) => q.comment_id), [q1.id]);
    assert.deepEqual(w.services.tasks.openQuestions({ forActor: w.dev2 }).map((q) => q.comment_id), [q2.id]);
    w.services.tasks.comment(t.key, { body: "ACME", kind: "answer", reply_to: q1.id }, w.manager);
    assert.equal(w.services.tasks.openQuestions({ forActor: w.manager }).length, 0);
    assert.ok(w.services.tasks.comments(t.id).find((c) => c.id === q1.id)?.resolved_at);
    assert.equal(w.services.tasks.myWork(w.dev).questions_for_me.length, 1);
  });
});

describe("my_work queues", () => {
  it("shows role-specific pull queues", () => {
    const w = makeWorld();
    const a = newTask(w, "needs analysis");
    const b = newTask(w, "ready one");
    w.services.tasks.update(b.key, { analysis: "x" }, w.dev);
    w.services.tasks.transition(b.key, "ready", w.dev);
    const dev = w.services.tasks.myWork(w.dev);
    assert.deepEqual(dev.pull.analysis!.map((t) => t.key), [a.key]);
    assert.deepEqual(dev.pull.implementation!.map((t) => t.key), [b.key]);
    const mgr = w.services.tasks.myWork(w.manager);
    assert.deepEqual(mgr.pull.triage!.map((t) => t.key), [a.key]); // b left inbox
    assert.deepEqual(mgr.pull.verify!.map((t) => t.key), []);
    const bot = w.services.tasks.myWork(w.bot);
    assert.equal(bot.pull.reported_open!.length, 2);
  });
});
