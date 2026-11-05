BRANCH: cluster/v6.5-partial-deps
HEAD: 7b961dd9d2c65091fc8c10b3672c444b14c237ff
## Summary
A task that needs only an interface of another is now a partial dependency in plan-slice: it does not chain, and its unit lists the interface files it waits on.
## Issues
- #626: done.
  - Partial dependency marked, unit starts once the interface lands -> "a partial dependency lets the unit start once the interface lands" -> tests/mutations/partial-deps-never-set-a-start-condition.json
  - B needs only A's interface, chain depth 1 -> "a task needing only an interface of another has chain depth 1, not 2" -> n/a. It passes without the fix too, because the base never chains such a task. It guards against a later change that chains partial deps.
  - Full dependency still chains -> "a full dependency still chains" -> n/a. It also passes without the fix and pins today's behaviour.
## Staged workflow changes
none
## Checkpoints
#626: 1 to 7 all yes. Reverting src/plan-slice.ts made the startsWhen test fail. make fast replaced toBeUndefined with an `in` check, because the loose-matcher check rejected it.
## Files outside my area
none
## Gate evidence
make fast: ok
Full make test: 4318 pass, 16 skip, 0 fail, 0 unhandled errors.
## Risk and rollback
Low. The new fields are optional, and nothing in src reads startsWhen yet. Revert the single commit.
## Learnings
- plan-deps.ts and groom.ts were not changed. groom.ts builds only linear deps, so nothing sets partialDeps outside tests yet.
- check-mutations needs the file name to equal the slug exactly, and the slug keeps the word "a".
- make fast rejects toBeUndefined as a loose matcher.
