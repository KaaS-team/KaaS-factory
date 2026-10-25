# Cursor Agent 2026.01.23-916f423: prompt delivery

Source: `cursor-agent --help` (help.txt), captured on this machine.

- The usage line is `agent [options] [command] [prompt...]` (help.txt:2): the prompt is a positional argument. No stdin prompt is documented, so the preset passes it as the last argument.
- `--mode plan` is the read-only mode. `--force` allows commands and is not needed for a plan-mode run.
- Skills: `.cursor/skills`. Context file: `AGENTS.md`.
