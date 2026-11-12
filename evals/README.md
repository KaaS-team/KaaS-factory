# Eval scorecards

Each `<date>-<workflow>-<agent>.json` is one scorecard from `factory eval`: pass rate, main green
rate, tokens per merged PR and wall time over the fixtures matrix. The `.md` beside it has the same
numbers for people to read. The agent field is the preset name, never a model name.

The nightly run writes a new pair here and commits it, so the folder is the history.
Pack upgrades compare two of them:

    factory eval diff evals/<old>.json evals/<new>.json

It prints each metric with its delta and exits 1 when the new one is worse on pass rate or on
tokens per merged PR (more than 10 percent up). Sample files here are fake-agent output.

`factory eval` copies each seed under `fixtures/<name>/seed` into a scratch repo, runs the agent
through the local dispatcher, then adds `hidden/<ticket>` and runs the fixture's `hidden` command.
