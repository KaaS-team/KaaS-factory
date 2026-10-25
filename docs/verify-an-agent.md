# Verify an agent

Only Claude is verified by the maintainers. Every other preset ships `verified: false`, and
`factory doctor` says "verified live: no". You can change that with your own
credentials and one pull request.

1. Install the agent's CLI and sign in to it (or set its API key in your shell).
2. Fork `splitbill`, install the factory there, and copy `.factory/config.example.json` to `config.json`.
3. Label the cent-split issue `factory:ready`, then run (it stops at the plan gate):

   ```
   bun bin/factory verify-agent <name> --repo-dir <your-fork> --issue <N>
   ```

   Read the plan and comment `/factory approve` on the issue, then run the same `verify-agent` command again. It resumes and records the rest.
   It runs every stage on that agent, writes a scrubbed fixture to `tests/fixtures/agents/<name>/`,
   and prints PASS or FAIL with the cost, tokens and duration.
4. On PASS, open a pull request to the factory that adds the fixture and sets `verified: true` on the preset.
5. On FAIL, open an issue with the printed output. Do not flip `verified`.

To try every installed agent in one go, run `make agent-matrix REPO_DIR=<your-fork> ISSUE=<N>`.
It names the agents it skips, and it spends tokens, so `make check` never runs it.

The recorder replaces API keys and your home directory in the fixture. Read the files before you
commit them.

## Per agent

Set the key the agent reads, then run step 3 with that name. `factory doctor` names the pinned CLI version.

| Agent | Install | Key |
| --- | --- | --- |
| `codex` | `npm i -g @openai/codex@0.156.1` | `OPENAI_API_KEY` |
| `gemini` | `npm i -g @google/gemini-cli@0.61.0` | `GEMINI_API_KEY` |
| `opencode` | `npm i -g opencode-ai@1.18.32`, then `opencode auth login` | the provider's key |
| `cursor` | Cursor's own installer (no versioned download) | `CURSOR_API_KEY` or `cursor-agent login` |
| `pi` | `npm i -g @mariozechner/pi-coding-agent@0.73.1` | the provider's key |
| `mastracode` | `npm i -g mastracode@0.42.0` | the provider's key |

The repo ships a synthetic fixture for each of these, written from the CLI's own docs. Your recording
replaces it. If the real events do not match the parser, the replay test fails: that is the bug to report.


## What to watch for, per agent

Each section says how the factory calls the agent and which behaviour no one has confirmed live. Those
are the lines your run settles.

### codex

Prompt on stdin (`codex exec --json -s <sandbox> -`). Triage, plan and verify run `-s read-only` and return their
artifact as the final message; build and pr run `workspace-write`. Unconfirmed: the `-` stdin form, from memory.

### gemini

Prompt on stdin, `-o stream-json`. Read-only stages use `--approval-mode plan`; write stages use `yolo`.
Unconfirmed: that plan mode is read-only in a headless run.

### opencode

Prompt on stdin. Read-only stages add `--agent plan` and return their artifact as the final message.
Unconfirmed: the event shapes and the usage fields (tokens may show as "Not reported").

### cursor

The prompt is the last argument, because the CLI documents no stdin prompt; a prompt over 120 KiB is refused
with a clear error. Write stages pass `--force`; read-only stages pass `--mode plan`.
Unconfirmed: what `--mode plan` allows, and the stream-json shape. Usage is never reported.

### pi

Prompt on stdin. Skills are read from `.pi/skills`. Unconfirmed: the read-only `--tools` allow-list.

### mastracode

Prompt on stdin, argv built by the ported flag table (`src/agents/presets/mastracode-flags.ts`).
It has no `--version` flag (it would read it as a prompt), so `factory doctor` cannot check its pin.
Unconfirmed: that `--mode plan` keeps a headless run read-only.
