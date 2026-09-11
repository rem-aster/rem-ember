import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EmberError } from "../errors.js";
import { FLOW_CHEATSHEET } from "../tools/identity.js";
import type { AnyToolDef, Services } from "../tools/registry.js";
import { runTool } from "../tools/registry.js";
import type { Actor } from "../types.js";

export const SERVER_NAME = "ember-mcp-server";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = [
  "Ember is a lean task tracker shared by humans and their agents. Every caller is identified by its bearer token; call ember_whoami first to learn your handle, role and open items, then ember_my_work to see what to pull.",
  "Roles: manager (product context, refines tasks, verifies), developer (code context, analyses and implements), reporter (ingest bots), admin.",
  ...FLOW_CHEATSHEET,
  "Task keys look like T-42. Handles look like @petya; agents are separate actors owned by a human (e.g. @petya-claude, owner @petya).",
  "Always leave a note when you release, drop or send a task back. Errors include a hint with the next step.",
].join("\n");

/**
 * Builds an McpServer wired to the shared tool registry. In stateless HTTP mode a fresh
 * instance is created per request (cheap: only tool registration), so no state lives here.
 */
export function createMcpServer(services: Services, tools: AnyToolDef[]): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: def.annotations,
      },
      async (args, extra): Promise<CallToolResult> => {
        const actor = extra.authInfo?.extra?.actor as Actor | undefined;
        if (!actor) {
          return errorResult(new EmberError("unauthorized", "No authenticated actor on this request"));
        }
        const res = await runTool(def, args, { actor, services });
        if (!res.ok) return errorResult(res.error);
        return {
          content: [{ type: "text", text: res.output.text }],
          structuredContent: res.output.data,
        };
      },
    );
  }
  return server;
}

function errorResult(err: EmberError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: err.toText() }],
    structuredContent: { error: err.toJSON() },
  };
}
