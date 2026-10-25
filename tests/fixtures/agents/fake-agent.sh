#!/bin/sh
# A stand-in for any coding agent with no preset and no JSON output: it reads
# the prompt on stdin and writes the stage's artifacts to $FACTORY_ARTIFACT_DIR.
# FAKE_VERDICT overrides verdict.json. FAKE_AGENT_LOG (a directory) keeps each stage's prompt for the tests to read.
prompt=$(cat)
[ -n "$FAKE_AGENT_LOG" ] && printf '%s' "$prompt" > "$FAKE_AGENT_LOG/$FACTORY_STAGE.prompt"
d="$FACTORY_ARTIFACT_DIR"
n="$FACTORY_ISSUE"
case "$FACTORY_STAGE" in
  triage)
    printf '<!-- factory:triage v1 -->\nlooks good\n' > "$d/triage-comment.md"
    printf '{"disposition":"proceed","type":"bug","risk":"low","done_when":"tests pass","files_expected":["src/a.ts"],"gate_level":"make check","confidence":0.9}\n' > "$d/triage.json" ;;
  plan)
    printf '<!-- factory:plan v1 rev=1 -->\nplan body\n' > "$d/plan-comment.md"
    printf '{"risk":"low","revision":1,"files":["src/a.ts"],"autoApproveEligible":true}\n' > "$d/plan.json" ;;
  build)
    printf '<!-- factory:status v1 -->\nbuilding\n' > "$d/status-comment.md"
    printf '{"status":"green","gate_line":"make check: 10 pass","rounds":1}\n' > "$d/build.json" ;;
  verify)
    printf '<!-- factory:verdict v1 -->\npass\n' > "$d/verdict-comment.md"
    if [ -n "$FAKE_VERDICT" ]; then printf '%s\n' "$FAKE_VERDICT" > "$d/verdict.json"
    else printf '{"result":"pass","rounds":1,"findings":[]}\n' > "$d/verdict.json"; fi ;;
  pr)
    printf '## Summary\nDid the thing.\nCloses #%s\n' "$n" > "$d/pr-body.md" ;;
esac
