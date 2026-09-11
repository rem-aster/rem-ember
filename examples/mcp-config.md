# Client configuration snippets

All agents talk to the same endpoint; only the token differs. One token = one actor.

## Claude Code (CLI)

```bash
claude mcp add --transport http ember https://ember.internal/mcp \
  --header "Authorization: Bearer ember_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Or per project in `.mcp.json` (token comes from the developer's environment, never from the repo):

```json
{
  "mcpServers": {
    "ember": {
      "type": "http",
      "url": "https://ember.internal/mcp",
      "headers": { "Authorization": "Bearer ${EMBER_TOKEN}" }
    }
  }
}
```

## Clients that only speak stdio (Claude Desktop, some IDEs)

Bridge with `mcp-remote`:

```json
{
  "mcpServers": {
    "ember": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://ember.internal/mcp",
        "--header", "Authorization: Bearer ${EMBER_TOKEN}"
      ],
      "env": { "EMBER_TOKEN": "ember_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
    }
  }
}
```

## Plain REST (scripts, bots, cron)

```bash
curl -s https://ember.internal/api/tools/ember_my_work \
  -H "Authorization: Bearer $EMBER_TOKEN" -H 'content-type: application/json' -d '{}'
```
