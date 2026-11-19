# f-r-graph: readability pass on internal/graph

## 1. Demo commands
No new command. A presenter shows the package still passes and no function is long:

    go test ./internal/graph/...
    ok  github.com/KaaS-team/factory/internal/graph
    ok  github.com/KaaS-team/factory/internal/graph/checkpoint
    ok  github.com/KaaS-team/factory/internal/graph/interrupt
    ok  github.com/KaaS-team/factory/internal/graph/scanedit

Longest function now: `addStep`, 58 lines (a throwaway AST scan over the area, counting braces to braces).

## 2. Acceptance
- No function over 60 lines: done. Three were over (`expandImports` 78, `build` 65, `LoadMarkdown` 61).
  They are now `parseMarkdownFront` / `markdownGraph`, `readSteps` / `readStep`, and an `importExpander`
  with `visit`, `load` and `readImportFront`.
- Tests first, unchanged after the split: done. `pin_test.go` pins the exact error text of every import
  and step failure; it passed before the split and after. No existing test was edited.
- Lines flat or down: **blocked, went up.** Non-test code 2219 to 2278 (+59): each new function adds a
  signature and a doc comment. All files incl. tests: 3826 to 3945 (+119, of which about 60 is `pin_test.go`).
  The ratchet step may flag this; that is the allowed failure.
- Package doc comments: done. All four packages had one; `graph`, `checkpoint`, `interrupt` and `scanedit`
  now say who calls them.
- Dead code: `deadcode` and `go vet` found nothing to delete in the area. `LoadDir` looks unused inside
  the area but `cmd/factory/doctor.go` and `packs` call it, so it stays.

## 3. Upstreams copied
None.

## 4. Files outside my area / workflow changes
None.
