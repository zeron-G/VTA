#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${COURSE_TA_ENV_FILE:-$SCRIPT_DIR/.env}"
VENV_DIR="${VTA_VENV_DIR:-$SCRIPT_DIR/.venv}"

command -v python3 >/dev/null 2>&1 || {
  echo "ERROR: Python 3.10 or newer is required." >&2
  exit 2
}

python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' || {
  echo "ERROR: Python 3.10 or newer is required." >&2
  exit 2
}

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE. Replace every REPLACE_ME value, then rerun ./deploy.sh." >&2
  exit 2
fi

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check "$SCRIPT_DIR"
exec "$VENV_DIR/bin/course-ta-deploy" --env-file "$ENV_FILE" deploy "$@"
