#!/usr/bin/env python3
"""
Minimal Telegram -> Ember bridge (stdlib only).

Long-polls a bot's updates and turns every text message from one chat into an Ember task
via the REST mirror. Idempotent: source_ref = "tg:<chat_id>:<message_id>", so re-running never
creates duplicates. Hashtags map to fields: #bug/#feature/#chore -> kind, #urgent/#high/#low -> priority.

Env:
  TG_BOT_TOKEN   Telegram bot token (bot must be in the chat; disable privacy mode or make it admin)
  TG_CHAT_ID     chat id to watch, e.g. -1001234567890
  EMBER_URL      e.g. http://127.0.0.1:8787
  EMBER_TOKEN    token of an Ember actor with role "reporter" (kind=bot)
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

TG_TOKEN = os.environ["TG_BOT_TOKEN"]
CHAT_ID = int(os.environ["TG_CHAT_ID"])
EMBER_URL = os.environ.get("EMBER_URL", "http://127.0.0.1:8787").rstrip("/")
EMBER_TOKEN = os.environ["EMBER_TOKEN"]
OFFSET_FILE = os.environ.get("TG_OFFSET_FILE", ".telegram_offset")

KIND_TAGS = {"#bug": "bug", "#feature": "feature", "#chore": "chore", "#question": "question"}
PRIO_TAGS = {"#urgent": "urgent", "#high": "high", "#low": "low"}


def post_json(url, payload, headers=None):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def tg(method, **params):
    return post_json(f"https://api.telegram.org/bot{TG_TOKEN}/{method}", params)["result"]


def ember(tool, payload):
    try:
        return post_json(f"{EMBER_URL}/api/tools/{tool}", payload, {"Authorization": f"Bearer {EMBER_TOKEN}"})
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"ember {tool} -> {e.code}: {body}") from None


def to_task(msg):
    text = (msg.get("text") or msg.get("caption") or "").strip()
    if not text:
        return None
    words = text.split()
    kind = next((KIND_TAGS[w.lower()] for w in words if w.lower() in KIND_TAGS), "other")
    priority = next((PRIO_TAGS[w.lower()] for w in words if w.lower() in PRIO_TAGS), "normal")
    first_line = text.splitlines()[0]
    title = first_line if len(first_line) <= 120 else first_line[:117] + "..."
    sender = msg.get("from", {})
    author = sender.get("username") or " ".join(filter(None, [sender.get("first_name"), sender.get("last_name")])) or "unknown"
    chat_id = msg["chat"]["id"]
    return {
        "title": title,
        "raw": text,
        "source_channel": "telegram",
        "source_ref": f"tg:{chat_id}:{msg['message_id']}",
        "source_author": author,
        "kind": kind,
        "priority": priority,
        "labels": ["telegram"],
    }


def load_offset():
    try:
        with open(OFFSET_FILE) as f:
            return int(f.read().strip() or 0)
    except FileNotFoundError:
        return 0


def save_offset(offset):
    with open(OFFSET_FILE, "w") as f:
        f.write(str(offset))


def main():
    offset = load_offset()
    print(f"watching chat {CHAT_ID}, offset {offset}", file=sys.stderr)
    while True:
        try:
            updates = tg("getUpdates", offset=offset, timeout=30, allowed_updates=["message"])
        except Exception as e:  # network hiccup: back off and retry
            print(f"telegram error: {e}", file=sys.stderr)
            time.sleep(5)
            continue
        for upd in updates:
            offset = upd["update_id"] + 1
            msg = upd.get("message")
            if not msg or msg["chat"]["id"] != CHAT_ID:
                continue
            task = to_task(msg)
            if not task:
                continue
            res = ember("ember_create_task", task)
            t = res["result"]["task"]
            verb = "created" if res["result"]["created"] else "exists"
            print(f"{verb} {t['key']}: {t['title']}", file=sys.stderr)
        save_offset(offset)


if __name__ == "__main__":
    main()
