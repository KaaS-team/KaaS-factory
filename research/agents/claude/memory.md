# Headless Claude auto-memory, under the factory's own flags

v2.10.0 item 1. Answers where headless Claude reads and writes auto-memory when invoked
with the factory's exact flags, and whether the factory can rely on it. It cannot; this
is why item 2 puts memory in the repo instead.

## Test

Local `claude` binary, v2.1.283. From a fresh, throwaway `git init` repo (no
`.claude/`, no `CLAUDE.md`), ran the same flags `claudeArgs` builds in
`src/agents/presets/claude.ts`:

```
claude -p "Reply with exactly one line: MEMORY_INSTRUCTIONS=yes if your system prompt or
context mentions any auto-memory system, a memory directory, RTK, or engineering.md;
otherwise MEMORY_INSTRUCTIONS=no. Do not use any tools." \
  --output-format stream-json --verbose \
  --setting-sources project,local \
  --no-session-persistence \
  --permission-mode dontAsk
```

`--setting-sources project,local` deliberately excludes `user`; `--no-session-persistence`
should mean no transcript is kept.

Since v2.12.0 `claudeArgs` no longer passes `--no-session-persistence`: each stage's session is kept
in `~/.claude/projects` so `factory takeover` can `claude --resume` it. The result below predates that.

## Result

- The model answered `MEMORY_INSTRUCTIONS=yes`: it saw the invoking user's global
  `~/.claude/CLAUDE.md` (RTK, engineering.md) despite `user` being excluded from
  `--setting-sources`.
- The CLI's own `system/init` event carried a live path:
  `"memory_paths":{"auto":"/Users/param/.claude/projects/<hash-of-cwd>/memory/"}`,
  where `<hash-of-cwd>` encodes the probe's absolute working directory.
- That directory exists on disk (created by the CLI on startup) but is empty: this run
  wrote nothing into it, only reserved the path.

## What this means

- **`--setting-sources` gates settings files, not the auto-memory/global-instructions
  mechanism.** That mechanism sits outside the user/project/local settings hierarchy and
  stayed active even with `user` excluded and session persistence off.
- **The memory path is keyed by a hash of the absolute working directory**, under the
  *invoking user's own* `~/.claude/projects/`. Two consequences for the factory:
  - A worktree at `factory/.worktrees/issue-N` gets its own distinct memory directory,
    unrelated to any other worktree's, the main checkout's, or a prior run's for the same
    issue once the worktree path changes. Nothing coalesces.
  - The directory lives under the operator's home directory. It is not in the repo, not
    portable to a different machine (a VPS runner), and not visible in CI.
- This is operator-machine-local state, not repo state. It cannot be the factory's memory
  mechanism: it cannot be read back by a run on a different machine, doesn't survive a
  worktree being torn down and recreated under a fresh path, and isn't inspectable in a PR
  diff for review.

## Conclusion

Confirms the roadmap's pre-decided design: **the factory never relies on `~/.claude`**.
Persistent lessons must live in the repo itself, at `.factory/memory/lessons.md`
(v2.10.0 item 2), injected through `buildContextPack` (`src/context.ts`) the same way for
every machine, worktree and CI run alike.
