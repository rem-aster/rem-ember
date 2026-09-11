/**
 * HTTP surface (Hono, web-standard Request/Response):
 *   GET  /healthz                 - liveness, no auth
 *   POST /mcp                     - MCP Streamable HTTP, stateless JSON mode
 *   GET  /api/tools               - tool catalogue with JSON schemas
 *   POST /api/tools/:name         - call a tool over plain REST (same registry, same auth)
 * Auth: Authorization: Bearer <token>; the token maps to exactly one actor.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { bearerFromHeader } from "../auth.js";
import { EmberError } from "../errors.js";
import type { AnyToolDef, Services } from "../tools/registry.js";
import { runTool, toolJsonSchema } from "../tools/registry.js";
import type { Actor } from "../types.js";
import { SERVER_NAME, SERVER_VERSION, createMcpServer } from "./mcp.js";

export interface AppOptions {
  /** Host header values accepted (hostnames without port). Empty = no host check. */
  allowedHosts: string[];
  bodyLimitBytes: number;
  log?: (line: string) => void;
}

type Env = { Variables: { actor: Actor } };

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

export function hostAllowList(bindHost: string, extra: string[]): string[] {
  const isLocal = LOCAL_HOSTS.includes(bindHost);
  if (!isLocal && extra.length === 0) return []; // exposed deliberately, operator did not restrict hosts
  return [...new Set([...LOCAL_HOSTS, ...extra])]; // loopback stays allowed for local health checks
}

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  const i = h.lastIndexOf(":");
  return i === -1 ? h : h.slice(0, i);
}

export function createApp(services: Services, tools: AnyToolDef[], opts: AppOptions) {
  const app = new Hono<Env>();
  const log = opts.log ?? ((line: string) => console.error(line));

  // Request log to stderr: method path status actor ms
  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const actor = c.get("actor");
    log(`[ember] ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${actor ? "@" + actor.handle : "-"} ${Date.now() - started}ms`);
  });

  // DNS-rebinding protection: validate Host header when we have an allow-list.
  if (opts.allowedHosts.length > 0) {
    const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
    app.use("*", async (c, next) => {
      const host = c.req.header("host");
      if (!host || !allowed.has(hostnameOf(host).toLowerCase())) {
        return c.json({ ok: false, error: { code: "forbidden", message: `Host header "${host ?? ""}" is not allowed` } }, 403);
      }
      await next();
    });
  }

  app.get("/healthz", (c) => c.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION }));

  const limit = bodyLimit({
    maxSize: opts.bodyLimitBytes,
    onError: (c) => c.json({ ok: false, error: { code: "invalid", message: "Request body too large" } }, 413),
  });
  app.use("/mcp", limit);
  app.use("/api/*", limit);

  // Authentication: bearer token -> actor. No token, no identity, no access.
  const auth = createMiddleware<Env>(async (c, next) => {
    const token = bearerFromHeader(c.req.header("authorization"));
    const actor = token ? services.actors.authenticate(token) : undefined;
    if (!actor) {
      c.header("WWW-Authenticate", 'Bearer realm="ember"');
      return c.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: token ? "Unknown or inactive token" : "Missing bearer token",
            hint: "Send Authorization: Bearer <token>. Tokens are issued by an admin (ember_create_actor or the ember-admin CLI).",
          },
        },
        401,
      );
    }
    services.tasks.sweepExpiredClaims();
    c.set("actor", actor);
    await next();
  });
  app.use("/mcp", auth);
  app.use("/api/*", auth);

  // MCP: stateless, JSON responses. A fresh server+transport per request keeps it horizontally trivial.
  app.post("/mcp", async (c) => {
    const actor = c.get("actor");
    const server = createMcpServer(services, tools);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, {
        authInfo: { token: "redacted", clientId: actor.handle, scopes: [actor.role], extra: { actor } },
      });
    } finally {
      // JSON mode returns a fully materialised body, so tearing down immediately is safe.
      void transport.close();
      void server.close();
    }
  });
  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("Allow", "POST");
    return c.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Stateless server: use POST /mcp" }, id: null },
      405,
    );
  });

  // REST mirror of the tool registry.
  app.get("/api/tools", (c) => {
    const actor = c.get("actor");
    return c.json({
      ok: true,
      actor: actor.handle,
      role: actor.role,
      tools: tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        roles: t.roles,
        allowed_for_you: t.roles.includes(actor.role),
        annotations: t.annotations,
        input_schema: toolJsonSchema(t),
        call: `POST /api/tools/${t.name}`,
      })),
    });
  });

  app.post("/api/tools/:name", async (c) => {
    const name = c.req.param("name");
    const def = tools.find((t) => t.name === name);
    if (!def) {
      return c.json(
        { ok: false, error: { code: "not_found", message: `Unknown tool "${name}"`, hint: `Known tools: ${tools.map((t) => t.name).join(", ")}` } },
        404,
      );
    }
    let args: unknown = {};
    const raw = await c.req.text();
    if (raw.trim()) {
      try {
        args = JSON.parse(raw);
      } catch {
        return c.json({ ok: false, error: { code: "invalid", message: "Body must be a JSON object" } }, 400);
      }
    }
    const res = await runTool(def, args, { actor: c.get("actor"), services });
    if (!res.ok) return c.json({ ok: false, error: res.error.toJSON() }, res.error.httpStatus() as 400);
    return c.json({ ok: true, result: res.output.data, text: res.output.text });
  });

  app.notFound((c) => c.json({ ok: false, error: { code: "not_found", message: `No route ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404));
  app.onError((err, c) => {
    if (err instanceof EmberError) return c.json({ ok: false, error: err.toJSON() }, err.httpStatus() as 400);
    console.error("[ember] unhandled error:", err);
    return c.json({ ok: false, error: { code: "internal", message: "Internal server error" } }, 500);
  });

  return app;
}
