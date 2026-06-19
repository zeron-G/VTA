#!/usr/bin/env python3
"""discord_counts.py — Pull per-user message counts from a Discord guild.

Counts only — no message text is stored. Uses the OpenClaw Discord plugin's
bot token from the active profile's openclaw.json.

Run from terminal:
    # Default: active profile, auto-detect guild, output to ~/Downloads/vta_discord_counts/
    python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/discord_counts.py"

    # Switch profile
    python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/discord_counts.py" --profile course-ta

    # Limit to messages on/after a date
    python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/discord_counts.py" --since 2026-01-01

    # Override guild or output dir
    python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/discord_counts.py" --guild <GUILD_ID> --out ~/vta-counts

Outputs (default ~/Downloads/vta_discord_counts/):
    counts_<UTCstamp>.csv    userId, displayName, role, channelId, channelName,
                             channelKind, parentChannel, week, count
    summary_<UTCstamp>.csv   userId, displayName, role, total
    run_<UTCstamp>.json      run metadata + server activation window
                             (first_student_message_at / last_student_message_at)
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Optional, Tuple

import requests

from paths import COURSE_TA_CONFIG, DISCORD_COUNTS_DIR, OPENCLAW_CONFIG

DISCORD_API = "https://discord.com/api/v10"

# Channel type constants per Discord docs.
TEXT_TYPES = {0, 5, 15}      # GUILD_TEXT, GUILD_ANNOUNCEMENT, GUILD_FORUM
THREAD_TYPES = {10, 11, 12}  # ANNOUNCEMENT_THREAD, PUBLIC_THREAD, PRIVATE_THREAD


class DiscordClient:
    def __init__(self, token: str):
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bot {token}",
            "User-Agent": "OpenClaw-CourseTA-counts/1.0",
        })

    def get(self, path: str, params: Optional[dict] = None) -> dict:
        url = f"{DISCORD_API}{path}"
        while True:
            r = self.session.get(url, params=params, timeout=30)
            if r.status_code == 429:
                wait = float(r.json().get("retry_after", 1.0))
                time.sleep(wait + 0.1)
                continue
            if r.status_code in (500, 502, 503, 504):
                time.sleep(2.0)
                continue
            if r.status_code == 403:
                raise PermissionError(path)
            r.raise_for_status()
            try:
                remaining = int(r.headers.get("X-RateLimit-Remaining", "1"))
                reset_after = float(r.headers.get("X-RateLimit-Reset-After", "0"))
                if remaining == 0 and reset_after > 0:
                    time.sleep(reset_after + 0.05)
            except (TypeError, ValueError):
                pass
            return r.json()


def load_token(profile: Optional[str], token_override: Optional[str]) -> Tuple[str, dict]:
    if token_override:
        return token_override, {}
    if profile:
        cfg_path = Path.home() / f".openclaw-{profile}" / "openclaw.json"
    else:
        cfg_path = OPENCLAW_CONFIG
    if not cfg_path.exists():
        sys.exit(f"Config not found: {cfg_path}")
    cfg = json.loads(cfg_path.read_text())
    discord = cfg.get("channels", {}).get("discord", {})
    token = discord.get("token")
    if not token:
        sys.exit(f"No discord token in {cfg_path}")
    return token, discord


def load_staff_roles() -> dict:
    """Map userId -> 'instructor' | 'ta' from course-ta.json."""
    if not COURSE_TA_CONFIG.exists():
        return {}
    cfg = json.loads(COURSE_TA_CONFIG.read_text())
    roles = {}
    for uid in cfg.get("admin_users", []):
        roles[str(uid)] = "instructor"
    for uid, meta in (cfg.get("privileged_users") or {}).items():
        role = (meta or {}).get("role", "")
        if role == "course_assistant":
            roles[str(uid)] = "ta"
        else:
            roles[str(uid)] = role or "staff"
    return roles


def list_text_channels(client: DiscordClient, guild_id: str) -> list:
    chans = client.get(f"/guilds/{guild_id}/channels")
    return [c for c in chans if c.get("type") in TEXT_TYPES]


def fetch_members(client: DiscordClient, guild_id: str) -> dict:
    """Return userId -> {nick, global_name, username, display}.

    Requires the Server Members privileged intent. Returns {} on 403 so the
    caller can fall back to per-message author info.
    """
    out: dict = {}
    after = "0"
    while True:
        try:
            page = client.get(
                f"/guilds/{guild_id}/members",
                params={"limit": 1000, "after": after},
            )
        except PermissionError:
            return {}
        if not page:
            return out
        for member in page:
            user = member.get("user") or {}
            uid = user.get("id")
            if not uid:
                continue
            nick = member.get("nick")
            global_name = user.get("global_name")
            username = user.get("username", "")
            out[uid] = {
                "nick": nick,
                "global_name": global_name,
                "username": username,
                "display": nick or global_name or username,
            }
            after = uid
        if len(page) < 1000:
            return out


def display_for(uid: str, directory: dict, fallback: dict) -> str:
    rec = directory.get(uid) or fallback.get(uid) or {}
    return rec.get("display") or rec.get("nick") or rec.get("global_name") \
        or rec.get("username") or ""


def list_active_threads(client: DiscordClient, guild_id: str) -> list:
    res = client.get(f"/guilds/{guild_id}/threads/active")
    return res.get("threads", [])


def list_archived_public_threads(client: DiscordClient, channel_id: str) -> Iterator[dict]:
    before = None
    while True:
        params = {"limit": 100}
        if before:
            params["before"] = before
        try:
            res = client.get(f"/channels/{channel_id}/threads/archived/public", params=params)
        except PermissionError:
            return
        threads = res.get("threads", [])
        if not threads:
            return
        for t in threads:
            yield t
        if not res.get("has_more"):
            return
        before = threads[-1]["thread_metadata"]["archive_timestamp"]


def iter_messages(client: DiscordClient, channel_id: str) -> Iterator[dict]:
    before = None
    while True:
        params = {"limit": 100}
        if before:
            params["before"] = before
        try:
            msgs = client.get(f"/channels/{channel_id}/messages", params=params)
        except PermissionError:
            return
        if not msgs:
            return
        for m in msgs:
            yield m
        before = msgs[-1]["id"]


def iso_week_start(ts: datetime) -> str:
    monday = ts - timedelta(days=ts.weekday())
    return monday.strftime("%Y-%m-%d")


def parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--profile", help="OpenClaw profile (default: active OPENCLAW_STATE_DIR)")
    p.add_argument("--token", help="Discord bot token override")
    p.add_argument("--guild", help="Guild ID (auto-detected from config if omitted)")
    p.add_argument("--since", help="YYYY-MM-DD; ignore messages before this date (UTC)")
    p.add_argument("--include-bots", action="store_true",
                   help="Count bot authors (default: skip)")
    p.add_argument("--out", type=Path, help=f"Output dir (default: {DISCORD_COUNTS_DIR})")
    args = p.parse_args()

    token, discord_cfg = load_token(args.profile, args.token)
    guild_id = args.guild
    if not guild_id:
        guilds = list((discord_cfg.get("guilds") or {}).keys())
        if len(guilds) != 1:
            sys.exit(f"--guild required (config has {len(guilds)} guilds: {guilds})")
        guild_id = guilds[0]

    since = parse_iso(args.since + "T00:00:00Z") if args.since else None
    out_dir = args.out or DISCORD_COUNTS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    staff_roles = load_staff_roles()
    print(f"Guild: {guild_id}", file=sys.stderr)
    print(f"Excluded staff (counts kept, no role=student): {len(staff_roles)} ids",
          file=sys.stderr)

    client = DiscordClient(token)
    directory = fetch_members(client, guild_id)
    if directory:
        print(f"Member directory: {len(directory)} entries", file=sys.stderr)
    else:
        print("Member directory: empty (Server Members intent off?) — "
              "falling back to per-message author info", file=sys.stderr)
    text_chans = list_text_channels(client, guild_id)
    chan_index = {c["id"]: c for c in text_chans}
    active_threads = list_active_threads(client, guild_id)

    archived_threads = []
    for c in text_chans:
        for t in list_archived_public_threads(client, c["id"]):
            archived_threads.append(t)
    print(f"Channels: {len(text_chans)} | active threads: {len(active_threads)} | "
          f"archived threads: {len(archived_threads)}", file=sys.stderr)

    targets = []
    for c in text_chans:
        if c.get("type") == 15:
            continue  # forum: only its threads carry messages
        targets.append({"id": c["id"], "name": c.get("name", ""),
                        "kind": "channel", "parent": ""})
    for t in active_threads + archived_threads:
        parent = chan_index.get(t.get("parent_id"), {}).get("name", "")
        targets.append({"id": t["id"], "name": t.get("name", ""),
                        "kind": "thread", "parent": parent})

    # (userId, channelId, week) -> count
    counts: dict = defaultdict(int)
    chan_meta = {t["id"]: t for t in targets}
    user_totals: Counter = Counter()
    fallback_dir: dict = {}
    user_first: dict = {}
    user_last: dict = {}
    first_student_ts: Optional[datetime] = None
    last_student_ts: Optional[datetime] = None
    total_msgs = 0

    for c in targets:
        n = 0
        for m in iter_messages(client, c["id"]):
            ts = parse_iso(m["timestamp"])
            if since and ts < since:
                continue
            author = m.get("author") or {}
            if author.get("bot") and not args.include_bots:
                continue
            uid = author.get("id")
            if not uid:
                continue
            if uid not in directory and uid not in fallback_dir:
                member_block = m.get("member") or {}
                fallback_dir[uid] = {
                    "nick": member_block.get("nick"),
                    "global_name": author.get("global_name"),
                    "username": author.get("username", ""),
                    "display": (member_block.get("nick")
                                or author.get("global_name")
                                or author.get("username", "")),
                }
            week = iso_week_start(ts)
            counts[(uid, c["id"], week)] += 1
            user_totals[uid] += 1
            if uid not in user_first or ts < user_first[uid]:
                user_first[uid] = ts
            if uid not in user_last or ts > user_last[uid]:
                user_last[uid] = ts
            if uid not in staff_roles:
                if first_student_ts is None or ts < first_student_ts:
                    first_student_ts = ts
                if last_student_ts is None or ts > last_student_ts:
                    last_student_ts = ts
            n += 1
        total_msgs += n
        print(f"  {c['kind']:7s} #{c['name'][:32]:<32s} {n:6d} msgs", file=sys.stderr)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    counts_path = out_dir / f"counts_{stamp}.csv"
    summary_path = out_dir / f"summary_{stamp}.csv"
    meta_path = out_dir / f"run_{stamp}.json"

    def role_for(uid: str) -> str:
        return staff_roles.get(uid, "student")

    with counts_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["userId", "displayName", "role", "channelId", "channelName",
                    "channelKind", "parentChannel", "week", "count"])
        for (uid, cid, week), n in sorted(counts.items()):
            meta = chan_meta.get(cid, {})
            w.writerow([uid, display_for(uid, directory, fallback_dir),
                        role_for(uid), cid, meta.get("name", ""),
                        meta.get("kind", ""), meta.get("parent", ""), week, n])

    with summary_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["userId", "displayName", "role", "total"])
        for uid, n in user_totals.most_common():
            w.writerow([uid, display_for(uid, directory, fallback_dir),
                        role_for(uid), n])

    meta_path.write_text(json.dumps({
        "guild_id": guild_id,
        "ran_at": stamp,
        "since": args.since,
        "include_bots": args.include_bots,
        "channels_scanned": len(targets),
        "messages_counted": total_msgs,
        "unique_users": len(user_totals),
        "students": sum(1 for u in user_totals if u not in staff_roles),
        "first_student_message_at": first_student_ts.isoformat() if first_student_ts else None,
        "last_student_message_at": last_student_ts.isoformat() if last_student_ts else None,
    }, indent=2))

    print(f"\nWrote {counts_path}", file=sys.stderr)
    print(f"Wrote {summary_path}", file=sys.stderr)
    print(f"Wrote {meta_path}", file=sys.stderr)
    if first_student_ts and last_student_ts:
        print(f"\nServer activation window (students only):", file=sys.stderr)
        print(f"  first: {first_student_ts.isoformat()}", file=sys.stderr)
        print(f"  last:  {last_student_ts.isoformat()}", file=sys.stderr)
    print(f"\nTop 10 users by message count:", file=sys.stderr)
    for uid, n in user_totals.most_common(10):
        name = display_for(uid, directory, fallback_dir)
        print(f"  {role_for(uid):10s}  {name:24s}  {uid}  {n}", file=sys.stderr)


if __name__ == "__main__":
    main()
