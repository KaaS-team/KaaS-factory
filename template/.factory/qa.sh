#!/bin/bash
# QA step: start the app, request each route in the plan's `routes` (or /), write qa.json, stop the app.
# Env: QA_COMMAND (starts the app), QA_URL (its base URL), FACTORY_ISSUE (optional; else the newest run).
set -u
: "${QA_COMMAND:?set QA_COMMAND to the command that starts the app}"
: "${QA_URL:?set QA_URL to the app base URL}"
root="$(git rev-parse --show-toplevel)"
issue="${FACTORY_ISSUE:-$(ls -t "$root/.factory/runs" | head -1 | sed s/^issue-//)}"
dir="$root/.factory/runs/issue-$issue"
mkdir -p "$dir"
routes="$(jq -r '(.routes // []) | .[]' "$dir/plan.json" 2>/dev/null)"
[ -n "$routes" ] || routes="/"
bash -c "$QA_COMMAND" >"$dir/qa-app.log" 2>&1 &
app=$!
trap 'kill "$app" 2>/dev/null; pkill -P "$app" 2>/dev/null; wait "$app" 2>/dev/null' EXIT
up=0
for _ in $(seq 1 60); do
  curl -s -o /dev/null --max-time 2 "$QA_URL" && { up=1; break; }
  sleep 0.5
done
rows=""; fail=0
[ "$up" = 1 ] || fail=1
while IFS= read -r path; do
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${QA_URL%/}$path")"
  [ "$up" = 1 ] && [ "$status" -ge 200 ] && [ "$status" -lt 400 ] && ok=true || { ok=false; fail=1; }
  rows="$rows$(jq -nc --arg p "$path" --argjson s "$status" --argjson o "$ok" '{path:$p,status:$s,ok:$o}')"$'\n'
done <<<"$routes"
printf '%s' "$rows" | jq -s '{routes: .}' >"$dir/qa.json"
exit "$fail"
