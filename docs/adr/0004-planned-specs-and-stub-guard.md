# 0004. Planned specs are checked before a run starts

## Status

accepted

## Context

An issue can carry its whole plan in its body, with the `<!-- factory:planned v1 -->` marker. If the
runner builds from a body that is missing a section, names a file it does not list, or asks for a
command the build may not run, the run fails late and costs a build.

## Decision

`importPlanStep` in `src/engine/import-plan-step.ts` checks a planned body before any build. The
checks come from three places:

- `parsePlannedIssue` in `src/engine/import-plan.ts`: the required sections (`Why`, `Change`,
  `Tests`, `Mutation`, `Acceptance`, `Files`, `Risk`), each task's dependencies, and that every
  file a task touches is listed under `Files`.
- `planMustFix` in `src/engine/plan-critic.ts`: each acceptance criterion ends with a
  `checked by` command, and every command is one the build or verify stage may run.
- `fileProblems` and `mutationProblems`, which check each listed file against the worktree (an
  existing file, or one marked `(new)`), and that each mutation's find text is in its file.

`scripts/lint-planned.ts` runs the same checks on a file, so an author can fix a body before filing.
After the checks pass, `floorPlanRisk` raises the plan's risk to the level the changed paths imply.

A body that fails any check is parked as `needs-human`, with each problem in one comment.

## Consequences

- A refused body costs no build. The author sees every problem at once.
- The risk of a planned issue cannot be lower than its paths imply.
- The code has no minimum-size rule for a plan. A short plan passes if its sections and commands
  are valid.

## Alternatives considered

- Let the build stage discover the problems. Rejected: the failure would come after the cost of a build.
- Let the author pick the risk. Rejected: `floorPlanRisk` raises a low rating that the paths do not support.
