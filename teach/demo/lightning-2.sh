#!/usr/bin/env bash
# The tmux layout, scene titles, screenshots and recording for the lightning-2 demo.
# The steps to run inside it are in teach/lightning-2.md.
# Usage: teach/demo/lightning-2.sh [--dry-run] [--record] [--tmux] up|attach|scene <n>|snap <name> [window]|down|scenes
#        teach/demo/lightning-2.sh [--dry-run] snapshot [dir]|replay [dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEMO_DIR="${DEMO_DIR:-$(cd "$ROOT/.." && pwd)/splitbill-demo}"
REPO="${DEMO_REPO:-learnwithparam/splitbill-demo}"
SESSION="${DEMO_SESSION:-lightning-2}"
PORT="${FACTORY_DASHBOARD_PORT:-4100}"
REPLAY_PORT="${REPLAY_PORT:-4101}"
VERSION="$(jq -r .version "$ROOT/package.json")"
OUT="${FACTORY_HOME:-$HOME/.factory}/recordings/lightning-2/v$VERSION"
WORKSPACES="${FACTORY_HOME:-$HOME/.factory}/$REPO/workspaces"
DRY=0
RECORD=0
# --tmux: the watcher opens a live window per issue in tmux session "factory" (v2.12.0).
WATCH_ARGS=""
# gh and git page their output on a TTY, which would freeze a refreshing pane.
NOPAGER=(-e PAGER=cat -e GH_PAGER=cat -e GIT_PAGER=cat)

SCENES=(
  "0|setup|reset, doctor, layout"
  "1|worktree per task|two issues, two worktrees, one cancelled"
  "2|sandbox boundaries|protected paths, allowed commands, budgets"
  "3|execution harness|label to claim to PR"
  "4|your branch isolated|my-feature untouched"
  "5|watch and take over|live issue window, takeover, hand back"
  "6|close|deliver and reset"
)

run() {
  if [ "$DRY" = 1 ]; then printf '%q ' "$@"; echo; else "$@"; fi
}

up() {
  if [ "$DRY" = 0 ] && tmux has-session -t "$SESSION" 2>/dev/null; then echo "session $SESSION already up"; return; fi
  # A second dashboard fails with "port in use" deep inside a pane; refuse here and name the holder.
  local holder
  holder="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ "$DRY" = 0 ] && [ -n "$holder" ]; then
    echo "port $PORT is held by pid $holder ($(ps -o command= -p "$holder" | cut -c1-80)); stop it first: kill $holder" >&2
    exit 1
  fi
  run tmux new-session "${NOPAGER[@]}" -d -s "$SESSION" -n you -c "$DEMO_DIR" -x 200 -y 50
  run tmux new-window "${NOPAGER[@]}" -t "$SESSION" -n factory -c "$ROOT" "make up REPO_DIR=$DEMO_DIR${WATCH_ARGS:+ WATCH_ARGS=$WATCH_ARGS}"
  run tmux split-window "${NOPAGER[@]}" -t "$SESSION:factory" -v -c "$DEMO_DIR" \
    "while :; do clear; git worktree list; ls $WORKSPACES 2>/dev/null; sleep 2; done"
  run tmux new-window "${NOPAGER[@]}" -t "$SESSION" -n logs -c "$ROOT"
  run tmux new-window "${NOPAGER[@]}" -t "$SESSION" -n boundary -c "$DEMO_DIR"
  run tmux new-window "${NOPAGER[@]}" -t "$SESSION" -n flow -c "$DEMO_DIR" \
    "while :; do clear; gh issue list -R $REPO --state all --limit 10 --json number,title,labels -q '.[]|\"#\\(.number) \\(.title[0:40])  \\(.labels|map(.name)|join(\" \"))\"'; sleep 5; done"
  run tmux set-option -t "$SESSION" status-left-length 80
  run tmux select-window -t "$SESSION:you"
  scene 0
}

scene() {
  local n="$1" row
  for row in "${SCENES[@]}"; do
    IFS='|' read -r id name what <<<"$row"
    if [ "$id" = "$n" ]; then run tmux set-option -t "$SESSION" status-left " lightning-2 | scene $id: $name "; return; fi
  done
  echo "no scene $n" >&2; exit 2
}

snap() {
  local name="$1" window="${2:-}"
  [ -n "$window" ] || window="$(tmux display-message -p -t "$SESSION" '#{window_name}')"
  run mkdir -p "$OUT"
  run bun "$ROOT/teach/demo/snap.ts" "$SESSION:$window" "$OUT/$name.png"
}

# A finished run as a mini FACTORY_HOME: the state DB plus each issue's stage artifacts.
# replay serves the dashboard on it, so the run can be walked through after reset wipes the real one.
snapshot() {
  local dir="${1:-$OUT/snapshot}" db="${FACTORY_HOME:-$HOME/.factory}/$REPO/factory.db" runs n
  if [ "$DRY" = 0 ] && [ -e "$dir" ]; then echo "$dir already exists; pass another dir or remove it" >&2; exit 1; fi
  if [ "$DRY" = 0 ] && [ ! -f "$db" ]; then echo "no factory.db at $db: nothing has run yet, or reset already wiped it" >&2; exit 1; fi
  run mkdir -p "$dir/$REPO/workspaces"
  run sqlite3 "$db" ".backup '$dir/$REPO/factory.db'"
  for runs in "$WORKSPACES"/issue-*/.factory/runs/issue-*; do
    [ -d "$runs" ] || continue
    n="$(basename "$runs")"
    run mkdir -p "$dir/$REPO/workspaces/$n/.factory/runs"
    run cp -R "$runs" "$dir/$REPO/workspaces/$n/.factory/runs/"
  done
  echo "snapshot in $dir; walk through it with: teach/demo/lightning-2.sh replay $dir"
}

replay() {
  local dir="${1:-$OUT/snapshot}" holder
  if [ "$DRY" = 0 ] && [ ! -f "$dir/$REPO/factory.db" ]; then echo "no snapshot at $dir (expected $dir/$REPO/factory.db)" >&2; exit 1; fi
  holder="$(lsof -nP -iTCP:"$REPLAY_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ "$DRY" = 0 ] && [ -n "$holder" ]; then echo "port $REPLAY_PORT is held by pid $holder; set REPLAY_PORT or stop it: kill $holder" >&2; exit 1; fi
  echo "replaying $dir on http://127.0.0.1:$REPLAY_PORT (Inbox and threads are live GitHub; Act buttons post real comments)"
  local cmd=(env FACTORY_HOME="$dir" bun "$ROOT/bin/factory" dashboard --repo "$REPO" --port "$REPLAY_PORT")
  # exec, so stopping this script stops the dashboard too.
  if [ "$DRY" = 1 ]; then run "${cmd[@]}"; else exec "${cmd[@]}"; fi
}

attach() {
  if [ "$RECORD" = 1 ]; then
    run mkdir -p "$OUT"
    run asciinema rec --idle-time-limit 2 --command "tmux attach -t $SESSION" "$OUT/session-$(date +%H%M%S).cast"
  else
    run tmux attach -t "$SESSION"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --record) RECORD=1; shift ;;
    --tmux) WATCH_ARGS="--tmux"; shift ;;
    *) break ;;
  esac
done

case "${1:-}" in
  up) up ;;
  attach) attach ;;
  scene) scene "${2:?scene number}" ;;
  snap) snap "${2:?shot name}" "${3:-}" ;;
  snapshot) snapshot "${2:-}" ;;
  replay) replay "${2:-}" ;;
  down) run tmux kill-session -t "$SESSION" ;;
  scenes) for row in "${SCENES[@]}"; do echo "$row"; done ;;
  *) sed -n 2,5p "$0" | sed 's/^# //'; exit 2 ;;
esac
