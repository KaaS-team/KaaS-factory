BRANCH: cluster/v8.0-context-hygiene
HEAD: f89b3a338fc455212a684ffc2796e45b75f5846b
## Summary
Always-loaded context is now measured on every stage run against a cap that may only go down. Lessons carry a date and expire at 90 days, and the learn PR removes them and reports context hygiene. `skill` and `gate: human` step types exist. The "template adopts vendored discipline skills" line is blocked.
## Issues
- #223: partly done, one line blocked.
  - Always-loaded tokens measured per run, cap ratchets down -> tests/context-budget.test.ts ("counts the context file...", "a run records its tokens...", "CommandExecutor leaves context-tokens.json...", "the cap sits within 10% of what the template measures") -> mutations: context-unscoped-rules-counted-as-scoped, context-run-records-no-over-cap-flag, context-cap-raised-past-the-template, context-pack-run-records-no-context-tokens.
  - Lessons expire, learn PR proposes hygiene -> tests/learn-hygiene.test.ts (expiry, pack drops expired, expiry-only PR, no PR when nothing to do, dated lessons, over-cap note) -> mutations: context-expired-lessons-kept, learn-expired-lesson-never-pruned, learn-new-lessons-carry-no-date.
  - Template adopts the vendored discipline skills -> BLOCKED. No vendored discipline skills exist in this repo or the template (only factory-*), the kit is not reachable from this sandbox, and writing new skills is out of scope. Needs the skill list or source from the supervisor.
  - `skill` step and `gate: human` (approve, steer, skip) -> tests/skill-gate-steps.test.ts (ok/not-ok/missing skill; gate parks, approve, skip, revise, outsider skip ignored; parser rules; `/factory skip` parse) -> mutations: skill-step-a-not-ok-answer-goes-on, skill-step-a-missing-skill-is-not-refused, gate-skip-command-ignored-on-resume, gate-skip-verb-not-parsed, gate-park-edge-needs-no-skip-exit, gate-skip-allowed-on-any-step.
  - Tests cover each of the four -> the three built lines above; the fourth (skills) has nothing to test.
  - Limits: a lesson with no `learned` date never expires (older lines are undated). A gate resumes through the plan comment, so a plan step must come before it (documented in docs/workflows.md). The skill step runs with triage's read-only tools.
## Staged workflow changes
none
## Checkpoints
1 area: no, see "Files outside my area". 2 scope: yes. 3 meaning: yes, except the blocked line. 4 proof: yes, each mutation shown as caught. 5 pins: yes, no cap raised (an executor.ts edit that exceeded its line cap was moved into src/context.ts instead). 6 neighbours: yes, full `make test` passes (4314 pass, 0 fail). 7 forbidden paths: yes.
## Files outside my area
- src/core/workflow.ts, src/core/workflow-extras.ts: step keys and the park edge's `skip:` (these are the workflow step types).
- src/chatops.ts: `/factory skip` verb.
- src/watch.ts: one line in resumeAwaitingApproval to follow `skip`; file length unchanged.
- src/engine/registry.ts: registers `skill` and `gate`.
- docs/workflows.md: documents the new keys.
## Gate evidence
make fast: ok
## Risk and rollback
Low. The cap is a constant (800) set from the shipped template's measure (732). New lessons use a new line format, and old lines still read. Roll back by reverting the branch's two commits.
## Learnings
- `make fast` fails on a format change that moves a mutation's `find` text: run `bun x biome format --write src tests` before writing mutation files.
- Quality baselines cap src/agents/executor.ts at 482 lines; hook new per-run work into src/context.ts instead.
- tests/skills-dir.test.ts fails if any new src file spells the skills directory path, even in a message.
- The brief's "vendored discipline skills" has no source in the repo; name the skills in the brief next time.
- `check-tests-only` rejects `toBeDefined()` as a loose matcher.
