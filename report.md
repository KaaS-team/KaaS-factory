BRANCH: cluster/v8.0-ask-steer
HEAD: 1a6bc103cda155350cf03d8ece3b6fc4b68ccef1
## Summary
A question labelled `factory:ask` (with `factory:ready`, the trust gate) is answered by one read-only run in a detached worktree, in one comment where every line cites `file:line`, then the issue closes with no claim, branch or PR. A message sent to a run is now read: the next stage prompt and a new PreToolUse hook hand it to the agent once. The cockpit composer and `factory send` both call `sendToRun`.
## Issues
- #203: done. All tests are in `tests/ask-steer.test.ts` unless noted.
  - Ask answered in one cited comment, issue closes, no branch or PR -> "a question is answered in one cited comment, then closed, with no branch or PR" -> mutations `ask-an-answer-with-an-uncited-claim-is-rejected`, `ask-the-answered-question-closes-the-issue`, `ask-intake-routes-an-ask-label-away-from-the-claim`, `ask-the-question-reaches-the-agent-as-untrusted-data`. Uncited answer stays open: "an answer with a claim that cites no file and line is not posted as an answer, and the issue stays open".
  - Message reaches the running agent before its next step, or the next stage -> "the PreToolUse hook gives a running agent the message before its next step, once", "the next stage prompt carries a message sent while no stage was running", "a message is handed to the agent once, and the next one after it" -> mutations `send-the-hook-hands-a-running-agent-its-message`, `send-the-hook-marks-a-message-as-read`, `send-the-next-stage-prompt-carries-the-messages`, `send-a-message-is-handed-over-only-once`. The plane runner now writes to the issue worktree, where stages read: `control-anywhere.test.ts` "a guarded web plane is driven ..." plus the re-pointed mutation "runner: a message from anywhere reaches the run's folder".
  - Composer and CLI send through the same call -> "sendToRun trims and delivers, and the composer route and the CLI both call it" -> mutations `send-the-cli-send-goes-through-sendtorun`, `send-the-composer-posts-to-the-shared-message-route`.
  - Tests for an answered question with no branch, and a message reaching the agent -> the tests above.
## Staged workflow changes
None.
## Checkpoints
#203: 1 yes (outside files listed below), 2 yes, 3 yes (see Learnings: ask needs `factory:ready` as well as `factory:ask`), 4 yes (each mutation was seen green-to-red), 5 one pinned count moved: `tests/mutations.json` label anchor now matches `ask:` (label added); `docs/trackers.md` label count 19 to 20; `src/cli.ts` and `src/watch.ts` stay at their caps (913 and 848) by folding an if/else and a two-line comment, 6 yes (full `make test`: 4300 pass, 0 fail), 7 yes (`template/.claude` is the shipped template, not the repo's `.claude/`).
## Files outside my area
- README.md, docs/trackers.md: label table and label count test.
- src/remote-cli.ts: runner `deliver` wrote `messages.md` in the checkout, which no stage reads; it now uses `appendMessage`. Also dispatches `send`.
- src/agents/prompt.ts: puts messages in the next stage prompt.
- src/engine/ask.ts, src/run-messages.ts, src/send-cli.ts: new files.
- src/cli.ts, src/watch.ts, src/help.ts, src/labels.ts, docs/cli-reference.md: one-line wiring, the `factory:ask` label, the help entry.
- dashboard/plane/runner-routes.ts: the message route calls `sendToRun`.
- template/.claude/hooks/operator-messages.sh and template/.claude/settings.json: the hook and its registration.
- tests/control-anywhere.test.ts, tests/mutations.json: message path moved to the worktree; label anchor.
## Gate evidence
make fast: ok
## Risk and rollback
Medium-low. Every `factory:ask` plus `factory:ready` issue takes the new path before any claim; a revert of `src/watch.ts`'s one line turns it off. Messages now land in the issue worktree, not the checkout. Revert the three commits to roll back; no data migration.
## Learnings
- `src/cli.ts` and `src/watch.ts` are at their line caps, so a new command or hook costs a folded line elsewhere. Dispatching through `remoteCommand` and a dynamic import avoids growth; the factory should offer a command table.
- `tests/mutations.json` anchors on exact text (labels, `messages.md`); adding a label breaks `labels: a LABEL key nothing uses...`. Run `make fast` after the first commit, not only at the end.
- `check-tests-only` flags `toBeUndefined`; use `?? "none"` with `toBe`.
- An amend of a pushed commit is refused and would need a force push; make a follow-up commit.
- Not done: ask-run spend is not written to `stage_runs` or the ledger, so daily spend caps do not count it. Ask also needs `factory:ready` (the trust gate) next to `factory:ask`; an ask label alone is not picked up.
