BRANCH: cluster/v6.4-base-traps
HEAD: 12b5d556551c5c283cbe2cb2b2497c32d9035475
## Summary
Added tests/source-traps.test.ts (three structural checks plus detector bite tests) and fixed every site it found: 12 bare comment openers in regex literals, 6 toMatchObject calls with asymmetric matchers, 144 spawn calls with no timeout, and the unused SessionRef import.
## Issues
- #675: done.
  - Regex openers -> "no regex literal in src, scripts or dashboard has a bare comment opener" -> tests/mutations/a-bare-comment-opener-in-a-regex-literal.json
  - toMatchObject -> "no test passes an asymmetric matcher inside toMatchObject" -> tests/mutations/an-asymmetric-matcher-inside-tomatchobject.json
  - Spawn timeout -> "every spawnSync and execFileSync in tests sets a timeout" -> tests/mutations/a-test-spawn-with-no-timeout.json
  - SessionRef -> biome check (make fast), no test; n/a
  - Each structural test has a mutation -> the three files above, all caught by check-mutations.
## Staged workflow changes
none
## Checkpoints
#675: 1 yes (outside files listed below), 2 yes, 3 yes, 4 partly: mutations show each test going red when its fix is undone; I did not separately run each test pre-fix by hand, 5 yes, 6 yes (changed tests rerun 3x), 7 yes.
## Files outside my area
src/engine/plan-reuse.ts, src/rehydrate.ts, src/comment-voice.ts: bare opener in a regex literal. src/mc/fake-adapter.ts: unused import named by the issue. tests/ported/machinist/runner.test.ts: needed mkdirSync(tmpdir()) for --rerun-each.
## Gate evidence
make fast: ok
## Risk and rollback
Low: regex changes are character-class equivalents, timeouts are 60s. Revert the two commits.
## Learnings
- make fast takes over 110s here; run it in the background or with a long timeout.
- Two comment lines mentioning the opener were wrongly rewritten by my perl pass and reverted; use the TS tokenizer for edits.
- tests/lean-resources.test.ts failed once in the full make test under load and passed alone.
- A codemod over spawn calls reformatted via biome; run biome --write after.
