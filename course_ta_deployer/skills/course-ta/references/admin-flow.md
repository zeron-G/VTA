# Administrator Flow

Use this flow only when preflight returns `role=admin` and the message has an
explicit administrative intent. Polite wording is not authorization.

## Configuration edits

1. Require a direct message for any request that would reveal configuration.
2. Read `editable_files` from `course-ta.json`; never accept an arbitrary path.
3. Resolve and verify the target remains inside the configured workspace.
4. Read the current value and describe the proposed change.
5. Write atomically while preserving unrelated fields.
6. Confirm only the changed public course information. Do not echo IDs, tokens,
   role lists, or filesystem paths.

Never edit `openclaw.json`, credential files, authentication profiles, or logs
through a Discord request.

## Channel changes

OpenClaw's Discord allowlist is canonical. Update it through the supported
OpenClaw configuration flow, then run:

```bash
python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/sync_channels.py" \
  --install-root "$OPENCLAW_STATE_DIR"
```

Do not create a wildcard channel rule.

## Canvas operations

Read operations may run directly. For a write request:

1. Verify `role=admin`.
2. State the exact Canvas object and intended change.
3. Use the Canvas client in confirmation mode.
4. Require the script's interactive confirmation.
5. Report success without exposing student records.

Useful read-only commands:

```bash
python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/canvas_sync.py" all --incremental
python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/canvas_dashboard.py" deadlines --days 7
python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/canvas_courses.py" status
```
