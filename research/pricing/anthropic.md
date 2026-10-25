# Anthropic pricing capture

Source: https://www.anthropic.com/pricing (redirects to https://claude.com/pricing).
Captured: 2026-09-27, via WebFetch.

USD per million tokens.

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| Opus 5.5 | 4 | 20 | 0.20 | 5 |
| Sonnet 5 | 2 | 10 | 0.20 | 2.50 |
| Haiku 4.5 | 1 | 5 | 0.10 | 1.25 |
| Fable 5.1 | 10 | 50 | 0.25 | 12.50 |
| Opus 5 / Opus 4.8 / 4.7 / 4.6 / 4.5 (legacy) | 5 | 25 | 0.50 | 6.25 |
| Sonnet 4.6 / 4.5 (legacy) | 3 | 15 | 0.30 | 3.75 |
| Fable 5 (legacy) | 10 | 50 | 1 | 12.50 |

`src/pricing.ts` already carries `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-opus-4-5` under
these exact numbers (they match this capture; no change needed there). This capture adds
`claude-opus-5-5` and `claude-sonnet-5`, which were previously unpriced (NULL cost).

## Update 2026-10-08 (WebFetch of https://claude.com/pricing)

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| Sonnet 5.5 | 2 | 10 | 0.10 | 2.50 |
| Fable 5.1 | 10 | 50 | 0.25 | 12.50 |
| Haiku 5.5 (prompt <= 100K) | 0.10 | 0.50 | 0.01 | 0.125 |
| Haiku 5.5 (prompt > 100K) | 0.50 | 2.50 | 0.05 | 0.625 |

`claude-sonnet-5-5` and `claude-fable-5-1` move into `PRICES`. Haiku 5.5 is tiered, which `Price`
cannot express, so it stays in `UNPRICED`.
