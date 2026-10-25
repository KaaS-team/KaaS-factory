# Stage stop hooks

## Failure

A stage that wrote a malformed artifact (a missing `gate_line`, a misspelled key) ran to the end
and the runner rejected it, which cost a whole new stage run. A verifier that hit a refused
command reported "could not verify" and the stage ended there (#46, #47, #73, #75).

## Measurement

claude 2.1.289, `-p`, dontAsk, a probe subagent ($0.03). The Stop input carries
`last_assistant_message` and `stop_hook_active`. SubagentStop also carries `agent_type` and
`agent_transcript_path`.

## Decision

1. The runner writes `artifact.schema.json` (`{file, schema, stoppedOwesOnlyOutcome}`, the
   schema from `stageSchema`) to `FACTORY_SCRATCH_DIR` for triage, plan, build and verify, the
   stages whose file `watch.ts` requires. pr and retro owe no file, so they are never checked. `stop-artifact.sh` checks the
   file against it and blocks the stop at most twice. Its checks mirror `validateStepJson`, and
   `tests/stop-artifact.test.ts` holds both to the same answers on one corpus. A blocked or
   failed verify owes only its outcome and summary, since the runner reads nothing else. For
   verify, whose validator is deeper, the test asserts only that the hook never blocks a verdict
   the runner accepts.
2. `stop-verifier-evidence.sh` blocks the verify stage's Stop once (`stop_hook_active`) when its
   last message names a command, shell or tool as denied or refused, or says a criterion could not be
   verified. "GET /admin is denied with 403" names no command, so it is a result.
3. `post-edit-check.sh` runs `postEditCommand` in the build stage after each edit, skipping the
   factory's own files under `.factory/` and the scratch dir. It is an argv list with `{file}` as
   one argument, never a shell string, so a file name cannot inject a command. Config validation
   refuses a string. A command that cannot start is reported to the agent, since a typo in it
   would otherwise switch the check off unseen.
4. Every other error in a stop or post-edit hook lets the call through, unlike `guard-paths.sh`.
   Failing open costs nothing here, because the runner validates the artifact again either way.

## Dropped

- Blocking a verifier report that claims a criterion without quoting a command: no reliable
  text test for it. `validateVerdict` already refuses a pass while any criterion is `fail` or
  `unverified`, so an unproven criterion cannot ship as a pass.
- A `factory doctor` line for an unset `postEditCommand`: off is the default, not a fault.
