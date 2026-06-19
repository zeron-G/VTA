# Maintenance

## Course materials

Place supported local material in the configured materials directory and rerun
deployment, or copy it into the active memory directory with an appropriate
course slug prefix. Supported source formats include Markdown, text, PDF, PPTX,
DOCX, CSV, and notebooks.

Extract slide decks when needed:

```bash
python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/extract_slides.py" \
  <source_directory> "$OPENCLAW_STATE_DIR/skills/course-ta/data/memory"
```

## Canvas sync

```bash
python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/canvas_sync.py" full <canvas_course_id>
python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/canvas_sync.py" incremental <canvas_course_id>
python3 "$OPENCLAW_STATE_DIR/skills/course-ta/lib/canvas_courses.py" status
```

After material changes:

```bash
openclaw --profile "$OPENCLAW_PROFILE" memory index --force
openclaw --profile "$OPENCLAW_PROFILE" memory status --json
```

## Health checks

From the VTA repository or installed command:

```bash
course-ta-deploy --env-file /secure/path/vta.env check
```

The check is read-only. It validates dependencies, model auth, Canvas identity
and course access, Discord bot/guild/channel access, gateway status, and the
memory index.

## Runtime privacy

Keep `data/logs`, `data/courses`, `data/credentials`, generated reports, Discord
count exports, and the OpenClaw state directory out of source control and public
support bundles. Rotate any credential immediately if it is exposed.
