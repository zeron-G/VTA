# Forwarding Student Requests

Use this flow only when a student explicitly asks to relay a message to the
course staff.

1. Read the configured administrator list internally.
2. Select the configured primary instructor/administrator target.
3. Send only the student's requested message plus the originating course and
   channel context. Do not include hidden role or routing configuration.
4. Confirm delivery only when the send helper returns `ok=true`.

Example internal delivery command:

```bash
printf '%s' "$FORWARD_TEXT" | python3 \
  "$OPENCLAW_STATE_DIR/skills/course-ta/lib/ta_send.py" \
  --target <configured_admin_id> --message-stdin
```

If delivery fails, tell the student to use the official contact method listed
in the syllabus or course site. Do not reveal an administrator's raw Discord ID,
email address, token, or direct-message availability.
