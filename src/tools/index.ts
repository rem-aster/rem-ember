import { identityTools } from "./identity.js";
import type { AnyToolDef } from "./registry.js";
import { taskTools } from "./tasks.js";
import { workTools } from "./work.js";

export const ALL_TOOLS: AnyToolDef[] = [...identityTools, ...taskTools, ...workTools] as AnyToolDef[];

export function findTool(name: string): AnyToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}
