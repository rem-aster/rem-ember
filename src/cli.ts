#!/usr/bin/env node
/**
 * ember-admin: break-glass administration straight against the database.
 * Needed once to bootstrap the first admin; afterwards ember_create_actor etc. work over MCP/REST.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { ActorService } from "./domain/actors.js";
import { EmberError } from "./errors.js";
import { ACTOR_KINDS, ROLES, type ActorKind, type Role } from "./types.js";

const USAGE = `ember-admin <command> [options]

Commands:
  create-actor   --handle H --name "Display Name" --kind human|agent|bot --role admin|manager|developer|reporter
                 [--owner H] [--context "..."] [--no-token]
  list-actors    [--all]
  rotate-token   --handle H
  deactivate     --handle H
  activate       --handle H
  set-role       --handle H --role R

Options:
  --db PATH      database file (default: $EMBER_DB_PATH or ./data/ember.db)
`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      handle: { type: "string" },
      name: { type: "string" },
      kind: { type: "string" },
      role: { type: "string" },
      owner: { type: "string" },
      context: { type: "string" },
      "no-token": { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const cmd = positionals[0];
  if (!cmd || values.help) {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  const cfg = loadConfig();
  const db = new Db(values.db ?? cfg.dbPath);
  const actors = new ActorService(db);
  const need = (v: string | undefined, name: string): string => {
    if (!v) throw new Error(`--${name} is required`);
    return v;
  };
  const oneOf = <T extends string>(v: string, allowed: readonly T[], name: string): T => {
    if (!(allowed as readonly string[]).includes(v)) throw new Error(`--${name} must be one of: ${allowed.join(", ")}`);
    return v as T;
  };

  try {
    switch (cmd) {
      case "create-actor": {
        const { actor, token } = actors.create(
          {
            handle: need(values.handle, "handle"),
            display_name: need(values.name, "name"),
            kind: oneOf<ActorKind>(need(values.kind, "kind"), ACTOR_KINDS, "kind"),
            role: oneOf<Role>(need(values.role, "role"), ROLES, "role"),
            owner: values.owner ?? null,
            context: values.context ?? null,
            issue_token: !values["no-token"],
          },
          null,
        );
        process.stdout.write(`created @${actor.handle} (${actor.kind}/${actor.role})\n`);
        if (token) process.stdout.write(`token: ${token}\n`);
        return 0;
      }
      case "list-actors": {
        for (const a of actors.list({ include_inactive: values.all })) {
          const owner = a.owner_id == null ? "" : ` owner=@${actors.byId(a.owner_id)?.handle ?? "?"}`;
          process.stdout.write(
            `@${a.handle}\t${a.kind}/${a.role}\t${a.display_name}${owner}${a.active ? "" : "\tINACTIVE"}${a.has_token ? "" : "\tno-token"}\tlast_seen=${a.last_seen_at ?? "never"}\n`,
          );
        }
        return 0;
      }
      case "rotate-token": {
        const { actor, token } = actors.rotateToken(need(values.handle, "handle"), null);
        process.stdout.write(`rotated @${actor.handle}\ntoken: ${token}\n`);
        return 0;
      }
      case "deactivate":
      case "activate": {
        const a = actors.update(need(values.handle, "handle"), { active: cmd === "activate" }, null);
        process.stdout.write(`@${a.handle} active=${a.active}\n`);
        return 0;
      }
      case "set-role": {
        const a = actors.update(
          need(values.handle, "handle"),
          { role: oneOf<Role>(need(values.role, "role"), ROLES, "role") },
          null,
        );
        process.stdout.write(`@${a.handle} role=${a.role}\n`);
        return 0;
      }
      default:
        process.stderr.write(`unknown command "${cmd}"\n\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    process.stderr.write(`error: ${e instanceof EmberError ? e.toText() : e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    db.close();
  }
}

process.exit(main(process.argv.slice(2)));
