TICKET: m3-graph-resume
NEXT: d14b2dc151b775366be18c0415a1418620cda16b
## Fixed
- A restart sent a ticket back to the first workflow node (duplicate sessions and PRs) -> d14b2dc; TestRestartResumesAtTheNodeReached (second node, parked on a human node), TestRestartWithUnknownNodeStartsOver, TestPositionRoundTripsAndSkipsOtherVersions, TestPositionCommentEditsOwnNotStrangers
- Design: one versioned `position` data marker (internal/marker) in one runner-owned comment, edited in place (observe.Positioner, GitHub tracker). Saved on advance, resume, park and when revise input is delivered. stageOf and recover read it; recover also uses the base so the observer counts attempts across nodes. Unknown node: start at g.Start plus one `warning` event.
## Bite checks
- TestRestartResumesAtTheNodeReached/second_node -> `after the restart the position is &{... node:plan ... base:0 ... pr:0}, want build, base 1, pr 3` (read in stageOf disabled)
- .../parked_on_a_human_node -> `position &{... node:plan ...}: want the human node`
- TestRestartWithUnknownNodeStartsOver -> `0 warning events, want 1`
## Not fixed
- Tutor `history` is empty after a restart: no attempt markers exist to rebuild it from.
- The position is its own comment; it is not folded into the human-park comment ("Needs a human: ...") to keep the codec in one place.
- A parked ticket with no saved position is left without a stage (not parked by a workflow node).
## Gate evidence
(no `just` installed; ./gate.sh, the same steps) on the rebased tree:
ok  	github.com/KaaS-team/factory/tools/ratchet	(cached)
go_lines 34251 (baseline 34251), deadcode 299 (baseline 299)
exit 0
Also `go test -race -count=3` on core, tracker, marker, observe, api: all ok (before the rebase).
## Learnings
- `just` missing; gate.sh takes over 2 minutes, run it in the background.
- The fake observer returns the old observation for any attempt, so a restart test must clear it.
- marker.Neutralise was replaced by sanitize.Publication on next; the rebase compiled only after switching.
- Ratchet raised by hand (go_lines 34251, deadcode 299), reason line updated.
- Commit trailer has no model name: the brief's trailer conflicts with its own rules.
