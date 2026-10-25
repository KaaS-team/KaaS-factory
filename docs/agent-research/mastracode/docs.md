# Mastra Code 0.42.0: prompt delivery

Source: mastra-ai/mastra@68fece5 `mastracode/sdk/src/headless/cli.ts` (Apache-2.0, `ee/` never read).

- `--prompt <text>` is required "or pipe via stdin" (help.txt:9). With `--prompt -` or no prompt and non-TTY stdin, the CLI reads stdin (cli.ts:176-178).
- `--mode plan` is Mastra's plan mode; whether it is read-only headless is unconfirmed, so stages also rely on `--permission-mode`.
