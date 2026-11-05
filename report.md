BRANCH: cluster/v8.0-team-routing
HEAD: 5b54c2678e7dceddb5669e48005fd663cb0f6a43
## Summary
The runner now routes each issue to its team by label or by a path its body names, and the dashboard filters runs, spend and the inbox per issue with a team picker in the left rail. The other #644 lines already held on the base.
## Issues
- #644: done.
  - Layers, nearest wins, org lock (already held) -> tests/team-layers.test.ts "nearest level wins", "an org lock" -> existing mutation files, no change.
  - Issues route by label or changed path -> tests/engine-team-config.test.ts "a label routes the run to the team that owns it", "a path the issue body names routes the run...", "advanceIssue runs an issue under the team its label routes to" -> tests/mutations/engine-the-run-ignores-the-issue-s-team.json, engine-an-issue-body-path-no-longer-routes.json
  - config explain names the level (already held) -> tests/team-layers.test.ts "config explain" -> existing.
  - A repo cannot loosen a locked org value (already held) -> tests/team-layers.test.ts "a repo cannot change a locked org value, loosening or not" -> existing.
  - Dashboard filters runs, spend, inbox by team -> tests/dashboard-team-issue.test.ts "runs, spend and the inbox keep only the issues the team owns in a shared repo", "the cockpit has a team control..." -> tests/mutations/dashboard-a-shared-repo-is-no-longer-split-by-issue.json, dashboard-the-inbox-ignores-the-issue-s-team.json, dashboard-spend-ignores-the-issue-s-team.json, dashboard-the-team-control-is-gone-from-the-rail.json, dashboard-the-team-is-not-sent-with-runs-and-the-inbox.json. tests/dashboard-team.test.ts gained /api/line?team= so layers-the-dashboard-ignores-the-team-filter still bites.
## Staged workflow changes
none
## Checkpoints
All seven yes. Checkpoint 5 deviation, reported: quality-baseline/lines/dashboard__server.ts.json raised 739 -> 751 (new /api/teams route and the team filter wiring; the logic lives in dashboard/team-filter.ts). src/watch.ts did not grow. Proof seen: engine wiring test failed with the runner change reverted; all five new dashboard mutations report "bites".
## Files outside my area
- src/engine/runner.ts: adds runUnderTeam so src/watch.ts (at its line cap) keeps its size.
- src/watch.ts: runFromStage calls runUnderTeam (2 lines changed).
- tests/mutations.json: two legacy entries (leases, analytics) re-pointed at the moved text.
- quality-baseline/lines/dashboard__server.ts.json: see Checkpoints.
## Gate evidence
make fast: ok
## Risk and rollback
Risk: a repo with .factory/team now reloads its config per issue, so config overrides applied after loadConfig at startup do not carry into the run. Any load error falls back to the startup config. In a shared repo, runs of closed issues have no known labels, so a team filter leaves them out. Rollback: revert the three commits.
## Learnings
- Full make test under load times out lean-resources, licensing and workflow; all pass alone. Run them alone before blaming a change.
- dashboard/server.ts and src/watch.ts sit exactly at their line caps; any edit needs helpers in a new file or a justified baseline raise.
- Runs carry no team or labels in state; storing the team on the run row would make closed-issue filtering exact.
- Legacy tests/mutations.json entries pin source text; grep it for any block you reformat.
- The brief's "changed path" has no diff at pickup; I used backticked paths in the issue body.
