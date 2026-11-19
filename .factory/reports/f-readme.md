# f-readme report

## Demo commands
In a repo where `gh auth login` is done, `claude` is on PATH, no `ANTHROPIC_*` is set, and the
`auditor` binary is installed:

    factory doctor                  # pass/fail rows for git, gh, claude, go, config, env
    factory init --tier solo        # asks for a tracker, writes .factory/factory.yaml
    factory first-run --dry-run     # audit, first fixes, dispatches nothing

Real output on the build machine (no gh login, ANTHROPIC_BASE_URL set, no auditor):

    fail  gh   gh is not logged in
    fail  env  ANTHROPIC_BASE_URL set
    factory: doctor: 2 check(s) failed
    wrote .factory/factory.yaml            (init --tier solo --yes --tracker github)
    factory: auditor binary "auditor" not found on PATH

The test runs all three green with fakes. `init` without `--yes` opens a full-screen form, so the
test adds `--yes --tracker github`.

## Acceptance
- README under 150 lines, every `factory <cmd>` checked against the built binary: done (102 lines).
- Quickstart test passes: done (`tools/quickstart`). Reverting a command name in the README turns it red.
- Gate: `./gate.sh` exit 0 (`just` is not installed here).

## Notes
- Tiers: the code has solo, startup, scaleup, enterprise, regulated, oss. The README maps the brief's
  four names (solo, team, org, enterprise) onto them in a table.
- README avoids the word "token" because `internal/docgen` TestREADME bans it.
- Existing `internal/docgen` TestREADME still requires "factory run" and "brew install".

## Upstreams copied
None. Opening shape and quickstart length followed the brief only; I did not fetch the upstream READMEs.

## Files outside my area
None. Workflow changes needed: none.
