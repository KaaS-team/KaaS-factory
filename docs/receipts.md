# Acceptance receipts

Every PR the factory opens carries a `## Receipt` section: the run's acceptance verdict as an
[in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) in a
[DSSE](https://github.com/secure-systems-lab/dsse) envelope, signed with Ed25519. The same envelope is
written to `.factory/runs/issue-<n>/receipt.dsse.json`, beside the files it pins.

## What it states

| Field | From |
|---|---|
| `subject[0]` | the head commit the PR ships |
| `run.base`, `run.head` | `git rev-parse origin/<base>` and `HEAD` in the run's worktree |
| `criteria[]` | each row of `scripts/lwp/check-acceptance.py --json`, with `proof` and `ok` derived from it |
| `holdout`, `mutationProof` | `holdout.json` and `proof.json` from verify |
| `steps[]` | each stage run; `model` and `costUsd` are null when `prRunSummary` is off |
| `artifacts` | the sha256 of each run-dir file above |
| `verdict` | counts, `proven`, and the `notProven` lines the PR shows under "Not proven" |

A criterion is ok when its holdout passes on the head and, if new, did not pass on the base: the
kit's own rule. `proven` needs at least one criterion, none failed, no acceptance error and no failed
holdout. A mutation proof that did not bite is listed under "Not proven" without failing the verdict.

The vocabulary is `verify/context.jsonld`, which maps every key to
[PROV-O](https://www.w3.org/TR/prov-o/) or the `kaas:` namespace; `tests/receipt.test.ts` fails when a
key has no term.

## Signing

```bash
factory receipt keygen --out ~/.config/factory/receipt.pem   # writes receipt.pem (0600) and receipt.pem.pub
```

Commit the `.pub` file as `.factory/receipt.pub`. Set `FACTORY_RECEIPT_KEY` on the runner to the PEM or
to its path (in CI, the `FACTORY_RECEIPT_KEY` secret). The `FACTORY_` prefix keeps it out of every agent
stage's environment, so no agent can sign its own receipt. Unset, the receipt goes out unsigned.

## Checking one

`verify/` is `kaas-verify`, a Rust checker that shares no code with the engine. It re-derives each
criterion's proof, the counts, `proven` and the "Not proven" list from the rows, so a receipt that claims
more than it proves is refused even under a good signature.

```bash
cargo build --release --manifest-path verify/Cargo.toml
kaas-verify receipt.dsse.json --pubkey .factory/receipt.pub [--artifacts .factory/runs/issue-42]
```

| Exit | Line | Means |
|---|---|---|
| 0 | `VERIFIED` | signed by that key, and every claim matches its rows (and files, with `--artifacts`) |
| 1 | `TAMPERED <field>: <why>` | a signature, a derived value or a pinned file does not match |
| 2 | `UNCHECKED` | signed, but no `--pubkey` was given to check it against |
| 3 | `UNSIGNED` | the runner had no key |

`factory receipt verify <file> --pubkey <key.pub>` checks only the signature, from the engine's own code.
