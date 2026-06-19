#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${COURSE_TA_ENV_FILE:-$SCRIPT_DIR/.env}"
VENV_DIR="${VTA_VENV_DIR:-$SCRIPT_DIR/.venv}"

if [[ ! -x "$VENV_DIR/bin/course-ta-deploy" ]]; then
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/python" -m pip install --disable-pip-version-check "$SCRIPT_DIR"
fi

exec "$VENV_DIR/bin/course-ta-deploy" --env-file "$ENV_FILE" check "$@"
