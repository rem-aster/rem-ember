#!/usr/bin/env node
/**
 * Ember: lean task tracker for agent-driven team development.
 * Surfaces: MCP (Streamable HTTP) and a small REST mirror. No UI by design.
 */
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { ActorService } from "./domain/actors.js";
import { TaskService } from "./domain/tasks.js";
import { createApp, hostAllowList } from "./server/http.js";
import { SERVER_NAME, SERVER_VERSION } from "./server/mcp.js";
import { ALL_TOOLS } from "./tools/index.js";
import type { Services } from "./tools/registry.js";

const cfg = loadConfig();
const db = new Db(cfg.dbPath);
const actors = new ActorService(db);
const tasks = new TaskService(db, actors, cfg);
const services: Services = { cfg, actors, tasks };

const app = createApp(services, ALL_TOOLS, {
  allowedHosts: hostAllowList(cfg.host, cfg.allowedHosts),
  bodyLimitBytes: cfg.bodyLimitBytes,
});

const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  console.error(`[ember] ${SERVER_NAME} ${SERVER_VERSION} listening on http://${info.address}:${info.port}  db=${cfg.dbPath}`);
  console.error(`[ember] MCP endpoint: POST /mcp   REST: /api/tools   tools: ${ALL_TOOLS.length}`);
  if (actors.count() === 0) {
    console.error(
      "[ember] No actors yet. Create the first admin:\n" +
        "        npm run admin -- create-actor --handle admin --name \"Admin\" --kind human --role admin",
    );
  }
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost" && cfg.allowedHosts.length === 0) {
    console.error("[ember] WARNING: bound to a non-loopback address without EMBER_ALLOWED_HOSTS; keep this port private (VPN / reverse proxy).");
  }
});

function shutdown(signal: string) {
  console.error(`[ember] ${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
