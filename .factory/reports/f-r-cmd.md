# f-r-cmd: readability pass on cmd/factory

## Demo commands
    go test -count=1 -run TestHelpGolden ./cmd/factory   # ok: --help of all 58 commands is byte for byte unchanged
    go run ./cmd/factory checkpoint --help                # same text as before the split
    go run ./cmd/factory design --help                    # same text as before the split

## Acceptance
- No function over 60 lines: done. Only `checkpointCmd` (83) and `designCmd` (68) were over. Both are split into one constructor per subcommand. A go/ast line counter now finds none.
- Tests written first pass unchanged: done. `help_golden_test.go` and `testdata/help.golden` (and `help_ee.golden` for the `ee` build) were generated before the split and pin `--help` of every command. No existing test changed.
- Lines go down or stay flat: NOT met. Non-test Go in cmd/factory: 1934 before, 1963 after (+29, from the new function signatures). Test Go: 2075 before, 2121 after (+46, the golden test). Plus golden data files. The split cost more lines than it saved and I found no dead code to delete (`deadcode` reports nothing in cmd/factory).
- Package doc comment: done. `main.go` now says what the command does and who calls it.
- Dead code: none found (`deadcode`, `go vet` clean).

## Upstreams copied
None.

## Files outside my area
None.

## Workflow changes needed
None.

## Gate
`./gate.sh` exit 0, 0 lint issues, ratchet: go_lines 43338 (baseline 43575), deadcode 311 (baseline 311). `just` is not installed in this session, so `./gate.sh` ran instead.
