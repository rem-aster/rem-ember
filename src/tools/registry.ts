/**
 * A single tool registry serves both surfaces: MCP (tools/call) and REST (POST /api/tools/:name).
 * Every tool receives the authenticated actor; identity is never taken from arguments.
 */
import { z } from "zod";
import type { Config } from "../config.js";
import type { ActorService } from "../domain/actors.js";
import type { TaskService } from "../domain/tasks.js";
import { EmberError } from "../errors.js";
import type { Actor, Role } from "../types.js";

export interface Services {
  cfg: Config;
  actors: ActorService;
  tasks: TaskService;
}

export interface ToolContext {
  actor: Actor;
  services: Services;
}

export interface ToolOutput {
  /** Human/agent-readable text (markdown). */
  text: string;
  /** Machine-readable payload, returned as MCP structuredContent and as the REST result. */
  data: Record<string, unknown>;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  /** Roles allowed to call the tool at all. Finer checks live in the domain layer. */
  roles: readonly Role[];
  handler: (args: z.output<S>, ctx: ToolContext) => ToolOutput | Promise<ToolOutput>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export type AnyToolDef = ToolDef<z.ZodObject>;

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
export const WRITE_IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };

export type ToolRunResult =
  | { ok: true; output: ToolOutput }
  | { ok: false; error: EmberError };

/** Validates input, enforces the role gate and runs the handler, mapping domain errors to a result. */
export async function runTool(def: AnyToolDef, rawArgs: unknown, ctx: ToolContext): Promise<ToolRunResult> {
  if (!def.roles.includes(ctx.actor.role)) {
    return {
      ok: false,
      error: new EmberError(
        "forbidden",
        `Role "${ctx.actor.role}" cannot use ${def.name}`,
        `Allowed roles: ${def.roles.join(", ")}.`,
      ),
    };
  }
  const parsed = def.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, error: new EmberError("invalid", `Invalid arguments for ${def.name}: ${issues}`) };
  }
  try {
    const output = await def.handler(parsed.data, ctx);
    return { ok: true, output };
  } catch (e) {
    if (e instanceof EmberError) return { ok: false, error: e };
    // Unknown failure: log server-side, hide internals from the caller.
    console.error(`[ember] tool ${def.name} failed for @${ctx.actor.handle}:`, e);
    return { ok: false, error: new EmberError("invalid", "Internal error while running the tool", "Retry; if it persists, contact an admin.") };
  }
}

export function toolJsonSchema(def: AnyToolDef): Record<string, unknown> {
  return z.toJSONSchema(def.input, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
}
