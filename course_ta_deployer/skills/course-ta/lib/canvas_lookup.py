#!/usr/bin/env python3
"""Local-only Canvas lookup — no Canvas API calls, reads pre-synced markdown.

Maintains a structured manifest from the synced Canvas content so the bot can
answer "what's due", "list assignments", "find X" without scanning all 102
memory files via RAG.

Outputs:
  data/courses/<slug>/canvas/manifest.json       — structured, for this CLI
  workspace/memory/<slug>__canvas-manifest.md    — human-readable, RAG-indexed

Usage:
  python3 canvas_lookup.py rebuild                          # regenerate manifest
  python3 canvas_lookup.py list <type>                      # one line per item
  python3 canvas_lookup.py find <pattern>                   # title regex match
  python3 canvas_lookup.py due [--before DATE] [--after DATE] [--days N]
  python3 canvas_lookup.py module <N>                       # items tagged M<N>
  python3 canvas_lookup.py show <slug-or-id>                # memory file path
  python3 canvas_lookup.py counts                           # one-line summary

Types: pages, assignments, announcements, discussions, quizzes, modules, files,
       syllabus, enrollments

All commands add --json to emit machine-readable output.
All commands auto-rebuild the manifest if any source markdown is newer.
"""

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from paths import COURSES_DIR, MEMORY_DIR, CANVAS_CONFIG


# ---------------------------------------------------------------------------
# Manifest build
# ---------------------------------------------------------------------------

HEADER_RE = re.compile(r"^>\s*\*\*([^*]+):\*\*\s*(.+?)\s*$")
TITLE_RE = re.compile(r"^#\s+(.+?)\s*$")
MODULE_PREFIX_RE = re.compile(r"^M(\d+)\b", re.IGNORECASE)


def _parse_md_headers(path: Path) -> dict:
    """Extract title + `> **Field:** Value` headers from a synced markdown file."""
    item = {"title": None, "memory_file": path.name}
    try:
        with open(path) as f:
            for i, line in enumerate(f):
                if i > 30:  # headers always near the top
                    break
                line = line.rstrip()
                if not line:
                    continue
                if item["title"] is None:
                    m = TITLE_RE.match(line)
                    if m:
                        item["title"] = m.group(1)
                        continue
                m = HEADER_RE.match(line)
                if m:
                    key = m.group(1).strip().lower().replace(" ", "_")
                    item[key] = m.group(2).strip()
    except OSError:
        return None
    if not item["title"]:
        return None
    # Derive module number from title prefix ("M4 Quiz #3" → module 4)
    mm = MODULE_PREFIX_RE.match(item["title"])
    if mm:
        item["module"] = int(mm.group(1))
    return item


def _active_courses() -> list:
    """Return list of (slug, canvas_id) for active courses."""
    if not CANVAS_CONFIG.exists():
        return []
    cfg = json.loads(CANVAS_CONFIG.read_text())
    return [(c["slug"], c["canvas_id"]) for c in cfg.get("active_courses", [])]


def _manifest_path(slug: str) -> Path:
    return COURSES_DIR / slug / "canvas" / "manifest.json"


def _memory_manifest_path(slug: str) -> Path:
    return MEMORY_DIR / f"{slug}__canvas-manifest.md"


def _stale(slug: str) -> bool:
    """True if any source MD is newer than the manifest (or manifest missing)."""
    mp = _manifest_path(slug)
    if not mp.exists():
        return True
    mtime = mp.stat().st_mtime
    canvas_dir = COURSES_DIR / slug / "canvas"
    for type_dir in canvas_dir.iterdir():
        if not type_dir.is_dir():
            continue
        for md in type_dir.glob("*.md"):
            if md.stat().st_mtime > mtime:
                return True
    return False


def build_manifest(slug: str) -> dict:
    """Scan synced markdown files, build structured manifest, write to disk."""
    canvas_dir = COURSES_DIR / slug / "canvas"
    if not canvas_dir.exists():
        print(f"  No synced data at {canvas_dir}", file=sys.stderr)
        return None

    items_by_type = {}
    for type_dir in sorted(canvas_dir.iterdir()):
        if not type_dir.is_dir():
            continue
        type_name = type_dir.name
        items = []
        for md in sorted(type_dir.glob("*.md")):
            entry = _parse_md_headers(md)
            if entry:
                # The corresponding memory file uses a different name pattern
                # e.g. data/courses/.../assignments/1142942-m1-individual-assignment.md
                #   →  data/memory/<slug>__canvas-assignment__m1-individual-assignment.md
                memname = _memory_file_for(slug, type_name, md.name)
                entry["memory_file"] = memname
                entry["source_file"] = str(md.relative_to(COURSES_DIR))
                items.append(entry)
        if items:
            items_by_type[type_name] = items

    manifest = {
        "slug": slug,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "counts": {k: len(v) for k, v in items_by_type.items()},
        "total": sum(len(v) for v in items_by_type.values()),
        "items_by_type": items_by_type,
    }
    _manifest_path(slug).write_text(json.dumps(manifest, indent=2) + "\n")
    _write_memory_manifest(slug, manifest)
    return manifest


_TYPE_SINGULAR = {
    "pages": "page",
    "assignments": "assignment",
    "announcements": "announcement",
    "discussions": "discussion",
    "quizzes": "quiz",
}


def _memory_file_for(slug: str, type_name: str, source_filename: str) -> str:
    """Map data/courses/<slug>/canvas/<type>/<source>.md → memory file basename."""
    if type_name == "modules":
        return f"{slug}__canvas-modules.md"
    if type_name == "syllabus":
        return f"{slug}__canvas-syllabus.md"
    if type_name == "files":
        return f"{slug}__canvas-files.md"
    if type_name == "enrollments":
        return None  # not indexed in memory by design
    type_singular = _TYPE_SINGULAR.get(type_name, type_name)
    # Strip the leading numeric ID prefix Canvas sync prepends: "1142942-m1-..." → "m1-..."
    name = re.sub(r"^\d+-", "", source_filename).removesuffix(".md")
    return f"{slug}__canvas-{type_singular}__{name}.md"


def _write_memory_manifest(slug: str, manifest: dict):
    """Write a human-readable manifest to memory/ for RAG indexing."""
    lines = [
        f"# Canvas Resource Manifest — {slug}",
        f"> **Course slug:** {slug}",
        f"> **Generated:** {manifest['generated_at']}",
        f"> **Total resources:** {manifest['total']}",
        "",
        "This is the index of all Canvas content available locally. Use this to know",
        "what exists; read the per-resource memory file for full content.",
        "",
    ]
    for type_name, items in manifest["items_by_type"].items():
        lines.append(f"## {type_name.title()} ({len(items)})")
        lines.append("")
        for it in items:
            parts = [f"- **{it.get('title','?')}**"]
            if it.get("due_date"):
                parts.append(f"due {it['due_date']}")
            if it.get("points"):
                parts.append(f"{it['points']} pts")
            if it.get("module"):
                parts.append(f"M{it['module']}")
            if it.get("memory_file"):
                parts.append(f"`{it['memory_file']}`")
            lines.append("  " + " · ".join(parts))
            if it.get("url"):
                lines.append(f"    {it['url']}")
        lines.append("")
    _memory_manifest_path(slug).write_text("\n".join(lines))


def load_manifest(slug: str, auto_rebuild: bool = True) -> dict:
    """Load the manifest, rebuilding if stale."""
    if auto_rebuild and _stale(slug):
        return build_manifest(slug)
    return json.loads(_manifest_path(slug).read_text())


# ---------------------------------------------------------------------------
# Lookup commands
# ---------------------------------------------------------------------------

def _resolve_slug(args: list) -> str:
    """Get --slug from args, default to first active course."""
    if "--slug" in args:
        idx = args.index("--slug")
        if idx + 1 < len(args):
            return args[idx + 1]
    active = _active_courses()
    if not active:
        print("  No active courses. Activate one with canvas_courses.py first.",
              file=sys.stderr)
        sys.exit(1)
    return active[0][0]


def _emit(items: list, as_json: bool, formatter=None):
    if as_json:
        print(json.dumps(items, indent=2))
        return
    if not items:
        print("  (no matches)")
        return
    for it in items:
        if formatter:
            print(formatter(it))
        else:
            print(f"  {it.get('title','?')}  →  {it.get('memory_file','-')}")


def cmd_rebuild(args: list):
    slug = _resolve_slug(args)
    m = build_manifest(slug)
    if m:
        print(f"  Rebuilt manifest for {slug}: {m['total']} items")
        for t, n in m["counts"].items():
            print(f"    {t}: {n}")


def cmd_list(args: list):
    if not args or args[0].startswith("--"):
        print("Usage: canvas_lookup.py list <type> [--json]", file=sys.stderr)
        sys.exit(1)
    type_name = args[0]
    slug = _resolve_slug(args)
    m = load_manifest(slug)
    items = m["items_by_type"].get(type_name, [])
    if not items and type_name.rstrip("s") in m["items_by_type"]:
        items = m["items_by_type"][type_name.rstrip("s")]
    def fmt(it):
        bits = [it.get("title", "?")]
        if it.get("due_date"):
            bits.append(f"due:{it['due_date'][:16]}")
        if it.get("points"):
            bits.append(f"pts:{it['points']}")
        bits.append(f"→ {it.get('memory_file', '-')}")
        return "  " + "  ".join(bits)
    _emit(items, "--json" in args, fmt)


def cmd_find(args: list):
    if not args or args[0].startswith("--"):
        print("Usage: canvas_lookup.py find <pattern> [--json]", file=sys.stderr)
        sys.exit(1)
    pattern = args[0]
    slug = _resolve_slug(args)
    m = load_manifest(slug)
    pat = re.compile(pattern, re.IGNORECASE)
    matches = []
    for type_name, items in m["items_by_type"].items():
        for it in items:
            if pat.search(it.get("title", "")):
                hit = {"type": type_name, **it}
                matches.append(hit)
    def fmt(it):
        return f"  [{it['type']:<13}] {it.get('title', '?')}  →  {it.get('memory_file', '-')}"
    _emit(matches, "--json" in args, fmt)


def cmd_due(args: list):
    slug = _resolve_slug(args)
    m = load_manifest(slug)
    now = datetime.now(timezone.utc)
    before = None
    after = now
    if "--before" in args:
        idx = args.index("--before")
        before = datetime.fromisoformat(args[idx + 1].replace("Z", "+00:00"))
    if "--after" in args:
        idx = args.index("--after")
        after = datetime.fromisoformat(args[idx + 1].replace("Z", "+00:00"))
    if "--days" in args:
        idx = args.index("--days")
        before = now + timedelta(days=int(args[idx + 1]))
    matches = []
    for type_name in ("assignments", "quizzes"):
        for it in m["items_by_type"].get(type_name, []):
            due = it.get("due_date")
            if not due:
                continue
            try:
                # Canvas format is "YYYY-MM-DD HH:MM UTC" (16 chars before ' UTC')
                d = datetime.strptime(due[:16], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            if after and d < after:
                continue
            if before and d > before:
                continue
            matches.append({"type": type_name, "due_dt": d.isoformat(), **it})
    matches.sort(key=lambda x: x["due_dt"])
    def fmt(it):
        return f"  {it['due_date']:<22}  [{it['type']:<11}] {it.get('title', '?')}  ({it.get('points','?')}pts)"
    _emit(matches, "--json" in args, fmt)


def cmd_module(args: list):
    if not args or args[0].startswith("--"):
        print("Usage: canvas_lookup.py module <N> [--json]", file=sys.stderr)
        sys.exit(1)
    try:
        n = int(args[0])
    except ValueError:
        print(f"Module number must be an integer, got {args[0]!r}", file=sys.stderr)
        sys.exit(1)
    slug = _resolve_slug(args)
    m = load_manifest(slug)
    matches = []
    for type_name, items in m["items_by_type"].items():
        for it in items:
            if it.get("module") == n:
                matches.append({"type": type_name, **it})
    def fmt(it):
        return f"  [{it['type']:<13}] {it.get('title', '?')}  →  {it.get('memory_file', '-')}"
    _emit(matches, "--json" in args, fmt)


def cmd_show(args: list):
    """Print the memory file path (or absolute) for a resource name/slug."""
    if not args or args[0].startswith("--"):
        print("Usage: canvas_lookup.py show <name-or-pattern>", file=sys.stderr)
        sys.exit(1)
    pattern = args[0]
    slug = _resolve_slug(args)
    m = load_manifest(slug)
    pat = re.compile(pattern, re.IGNORECASE)
    for type_name, items in m["items_by_type"].items():
        for it in items:
            if pat.search(it.get("title", "")) or pat.search(it.get("memory_file") or ""):
                mf = it.get("memory_file")
                if mf:
                    print(str(MEMORY_DIR / mf))
                    return
    print(f"  (no match for {pattern!r})", file=sys.stderr)
    sys.exit(1)


def cmd_counts(args: list):
    slug = _resolve_slug(args)
    m = load_manifest(slug)
    if "--json" in args:
        print(json.dumps({"slug": slug, "total": m["total"], **m["counts"]}, indent=2))
        return
    print(f"  {slug}: {m['total']} resources")
    for t, n in m["counts"].items():
        print(f"    {t:<14} {n}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd, args = sys.argv[1], sys.argv[2:]
    handlers = {
        "rebuild": cmd_rebuild,
        "list": cmd_list,
        "find": cmd_find,
        "due": cmd_due,
        "module": cmd_module,
        "show": cmd_show,
        "counts": cmd_counts,
    }
    if cmd not in handlers:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print(f"Available: {', '.join(handlers)}", file=sys.stderr)
        sys.exit(1)
    handlers[cmd](args)


if __name__ == "__main__":
    main()
