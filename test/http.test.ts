import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { after, before, describe, it } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, hostAllowList } from "../src/server/http.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { makeWorld, type World } from "./helpers.js";

let w: World;
let server: ServerType;
let base = "";

before(async () => {
  w = makeWorld();
  const app = createApp(w.services, ALL_TOOLS, {
    allowedHosts: hostAllowList("127.0.0.1", []),
    bodyLimitBytes: 64 * 1024,
    log: () => {},
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function mcpClient(token: string) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe("http surface", () => {
  it("healthz is open, everything else needs a bearer token", async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /Bearer/);
    const bad = await fetch(`${base}/api/tools`, { headers: { Authorization: "Bearer ember_wrong" } });
    assert.equal(bad.status, 401);
  });
  it("rejects foreign Host headers (DNS rebinding) and non-POST on /mcp", async () => {
    // fetch() silently drops a custom Host header, so use node:http for this one.
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/healthz`);
      httpRequest({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on("error", reject)
        .end();
    });
    assert.equal(status, 403);
    const g = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${w.tokens.admin}` } });
    assert.equal(g.status, 405);
    assert.equal(g.headers.get("allow"), "POST");
  });
  it("enforces the body limit", async () => {
    const r = await fetch(`${base}/api/tools/ember_create_task`, {
      method: "POST",
      headers: { Authorization: `Bearer ${w.tokens["tg-bot"]}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "x", raw: "y".repeat(70 * 1024) }),
    });
    assert.equal(r.status, 413);
  });
  it("REST mirrors the registry with role and validation errors", async () => {
    const call = (token: string, name: string, body: unknown) =>
      fetch(`${base}/api/tools/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
    const created = await call(w.tokens["tg-bot"]!, "ember_create_task", { title: "Bug", raw: "it broke", source_ref: "tg:1:1" });
    assert.equal(created.status, 200);
    assert.equal(created.body.result.created, true);
    const key = created.body.result.task.key as string;
    const dup = await call(w.tokens["tg-bot"]!, "ember_create_task", { title: "Bug", raw: "it broke", source_ref: "tg:1:1" });
    assert.equal(dup.body.result.created, false);
    assert.equal((await call(w.tokens["tg-bot"]!, "ember_update_task", { task_id: key, priority: "high" })).status, 403);
    assert.equal((await call(w.tokens["tg-bot"]!, "ember_create_task", { title: "" })).status, 400);
    assert.equal((await call(w.tokens["tg-bot"]!, "ember_nope", {})).status, 404);
    const cat = await fetch(`${base}/api/tools`, { headers: { Authorization: `Bearer ${w.tokens["tg-bot"]}` } }).then((r) => r.json() as any);
    assert.equal(cat.tools.length, ALL_TOOLS.length);
    assert.equal(cat.tools.find((t: any) => t.name === "ember_create_actor").allowed_for_you, false);
    assert.deepEqual(cat.tools.find((t: any) => t.name === "ember_create_task").input_schema.required, ["title", "raw"]);
  });
  it("MCP client sees tools, instructions and its own identity from the token", async () => {
    const client = await mcpClient(w.tokens["petya-claude"]!);
    try {
      assert.ok(client.getInstructions()?.includes("ember_whoami"));
      const tools = await client.listTools();
      assert.equal(tools.tools.length, ALL_TOOLS.length);
      const who = await client.callTool({ name: "ember_whoami", arguments: {} });
      assert.equal(who.isError, undefined);
      assert.equal((who.structuredContent as any).actor.handle, "petya-claude");
      const err = await client.callTool({ name: "ember_create_actor", arguments: { handle: "x1", display_name: "x", kind: "bot", role: "reporter" } });
      assert.equal(err.isError, true);
      assert.equal((err.structuredContent as any).error.code, "forbidden");
      const claim = await client.callTool({ name: "ember_claim_task", arguments: { task_id: "T-1", purpose: "analysis" } });
      assert.equal(claim.isError, undefined);
      assert.equal((claim.structuredContent as any).task.status, "analysis");
    } finally {
      await client.close();
    }
    const other = await mcpClient(w.tokens["kolya-claude"]!);
    try {
      const conflict = await other.callTool({ name: "ember_claim_task", arguments: { task_id: "T-1", purpose: "analysis" } });
      assert.equal(conflict.isError, true);
      assert.equal((conflict.structuredContent as any).error.details.holder, "petya-claude");
      const actors = await other.callTool({ name: "ember_list_actors", arguments: { response_format: "json" } });
      const petya = (actors.structuredContent as any).actors.find((a: any) => a.handle === "petya-claude");
      assert.equal(petya.claims[0].task, "T-1");
    } finally {
      await other.close();
    }
  });
});
