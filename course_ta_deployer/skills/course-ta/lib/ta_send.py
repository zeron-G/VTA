#!/usr/bin/env python3
"""ta_send.py — Send a plain-text Discord message to a thread or channel.

Calls Discord's REST API directly using the bot token from openclaw.json.
This bypasses two problems:
  1. The `message:send` tool's JSON Schema forces empty `components.modal`
     defaults that fail validation and produce broken "interaction failed"
     buttons.
  2. Shelling out to `openclaw message send` is slow (~5–7s of Node.js
     startup + gateway WebSocket handshake) — long enough that the bot's
     exec tool sometimes backgrounds and SIGTERMs the call, leaving the
     bot to fall back to `message:send` (which re-introduces problem 1).

Direct REST is typically <1s, no shell escaping, no components field.

Usage:
    python3 ta_send.py --target <channelOrThreadId> --message "<text>"
    python3 ta_send.py --target <channelOrThreadId> --message-stdin
    python3 ta_send.py --target <channelOrThreadId> --message-file <path>

Optional:
    --reply-to <id>           Reply-to message id
    --profile-config <path>   Path to openclaw.json (default: active VTA profile)
    --timeout <seconds>       HTTP timeout (default: 15)

Output (stdout, single-line JSON):
    {"ok": true, "messageId": "<id>", "channelId": "<id>"}
On failure:
    {"ok": false, "error": "<message>", "status": <http_status?>}

Exit codes:
    0  success
    2  empty message / bad args
    3  network / timeout
    4  HTTP error from Discord
    5  config not found / token missing
"""

from __future__ import annotations
import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

from paths import OPENCLAW_CONFIG


def _load_token(config_path: Path) -> str:
    if not config_path.exists():
        print(json.dumps({"ok": False, "error": f"openclaw config not found at {config_path}"}))
        sys.exit(5)
    with open(config_path) as f:
        cfg = json.load(f)
    token = (cfg.get("channels", {}) or {}).get("discord", {}).get("token") or ""
    if not token:
        print(json.dumps({"ok": False, "error": "no discord bot token in openclaw.json channels.discord.token"}))
        sys.exit(5)
    return token


def _read_text(args) -> str:
    if args.message:
        return args.message
    if args.message_stdin:
        return sys.stdin.read()
    return Path(args.message_file).read_text()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target", required=True, help="Discord channel id or thread id (numeric)")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--message", help="Message text (inline)")
    group.add_argument("--message-stdin", action="store_true", help="Read text from stdin")
    group.add_argument("--message-file", help="Read text from file path")
    ap.add_argument("--reply-to", default=None, help="Reply-to message id")
    ap.add_argument("--profile-config", default=str(OPENCLAW_CONFIG),
                    help="Path to openclaw.json")
    ap.add_argument("--timeout", type=float, default=15.0, help="HTTP timeout in seconds (default: 15)")
    args = ap.parse_args()

    text = _read_text(args)
    if not text.strip():
        print(json.dumps({"ok": False, "error": "empty message"}))
        return 2

    # Discord caps single message at 2000 chars; warn if longer (still try the send)
    over = len(text) - 2000

    token = _load_token(Path(args.profile_config))
    url = f"https://discord.com/api/v10/channels/{args.target}/messages"
    payload = {"content": text}
    if args.reply_to:
        payload["message_reference"] = {"message_id": str(args.reply_to)}

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            "User-Agent": "VTA/1.0 (https://github.com/zeron-G/VTA)",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read().decode("utf-8"))
        except Exception:
            err_body = {"message": str(e)}
        out = {
            "ok": False,
            "error": err_body.get("message", "discord http error"),
            "status": e.code,
            "discord_code": err_body.get("code"),
        }
        print(json.dumps(out))
        return 4
    except urllib.error.URLError as e:
        print(json.dumps({"ok": False, "error": f"network error: {e}"}))
        return 3
    except TimeoutError:
        print(json.dumps({"ok": False, "error": f"timed out after {args.timeout}s"}))
        return 3

    out = {
        "ok": True,
        "messageId": body.get("id"),
        "channelId": body.get("channel_id") or args.target,
    }
    if over > 0:
        out["warning"] = f"message was {len(text)} chars, over Discord's 2000-char limit by {over}"
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
