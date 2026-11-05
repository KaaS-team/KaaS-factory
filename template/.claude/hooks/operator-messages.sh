#!/usr/bin/env bash
# PreToolUse hook. Inside a factory stage, hands the agent what the operator
# sent to this run since its last step, once. Any error lets the step through unchanged.
set -uo pipefail

[ -n "${FACTORY_STAGE:-}" ] && [ -n "${FACTORY_ARTIFACT_DIR:-}" ] || exit 0
FILE="$FACTORY_ARTIFACT_DIR/messages.md"
SEEN="$FACTORY_ARTIFACT_DIR/messages.read"
[ -f "$FILE" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
INPUT="$(cat)"

python3 - "$FILE" "$SEEN" "$INPUT" <<'PY'
import json
import os
import sys

file, seen = sys.argv[1], sys.argv[2]
try:
    event = json.loads(sys.argv[3]).get("hook_event_name") or "PreToolUse"
except Exception:
    event = "PreToolUse"
try:
    data = open(file, "rb").read()
    off = int(open(seen).read().strip() or 0) if os.path.exists(seen) else 0
    if len(data) <= off:
        sys.exit(0)
    text = data[off:].decode("utf-8", "replace").strip()
    open(seen, "w").write(str(len(data)))
except Exception:
    sys.exit(0)
note = "The operator sent a message to this run. Follow it where it applies:\n" + text
print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": note}}))
PY
exit 0
