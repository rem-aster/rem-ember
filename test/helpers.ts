import { loadConfig, type Config } from "../src/config.js";
import { Db } from "../src/db.js";
import { ActorService } from "../src/domain/actors.js";
import { TaskService } from "../src/domain/tasks.js";
import type { Services } from "../src/tools/registry.js";
import type { Actor } from "../src/types.js";

export interface World {
  db: Db;
  services: Services;
  admin: Actor;
  manager: Actor;
  dev: Actor;
  dev2: Actor;
  bot: Actor;
  tokens: Record<string, string>;
}

export function makeWorld(overrides: Partial<Config> = {}): World {
  const cfg: Config = { ...loadConfig({}), dbPath: ":memory:", ...overrides };
  const db = new Db(":memory:");
  const actors = new ActorService(db);
  const tasks = new TaskService(db, actors, cfg);
  const tokens: Record<string, string> = {};
  const mk = (handle: string, role: Actor["role"], kind: Actor["kind"], owner?: string) => {
    const { actor, token } = actors.create({ handle, display_name: handle, kind, role, owner: owner ?? null }, null);
    tokens[handle] = token!;
    return actor;
  };
  const admin = mk("admin", "admin", "human");
  const manager = mk("masha-claude", "manager", "agent");
  const dev = mk("petya-claude", "developer", "agent");
  const dev2 = mk("kolya-claude", "developer", "agent");
  const bot = mk("tg-bot", "reporter", "bot");
  return { db, services: { cfg, actors, tasks }, admin, manager, dev, dev2, bot, tokens };
}

export function newTask(w: World, title = "Export hangs", extra: Record<string, unknown> = {}) {
  return w.services.tasks.create({ title, raw: `raw: ${title}`, source_channel: "telegram", ...extra }, w.bot).task;
}
