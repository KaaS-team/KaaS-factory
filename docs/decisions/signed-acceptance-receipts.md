# Signed acceptance receipts

The PR's Acceptance table was the factory reporting on itself: a reviewer had to trust the runner that
wrote it. A receipt makes the claim checkable by someone who trusts neither the runner nor this repo.

- **in-toto Statement in DSSE.** Both are open specs with existing verifiers (cosign, in-toto). The
  predicate type is ours; the envelope and signature scheme are not.
- **A second implementation.** `kaas-verify` is Rust and reads only the JSON, so a bug in `src/receipt.ts`
  that signs a wrong verdict is caught by a checker that cannot share the bug. The forgeries in
  `tests/receipt.test.ts` are signed with the real key; only re-derivation refuses them.
- **Derived, never typed.** Every count and the "Not proven" list are computed from the rows on both
  sides, so no number in the verdict is typed by hand. The idea comes from open-ontologies and
  loki-mode (ideas only; loki-mode's licence is unstated, so no code is taken from either).
- **Four exit codes.** Unsigned and unchecked are not tampered, so a script can tell "no key" from
  "forged" without reading the line.
- **No receipt is still a section.** When the worktree cannot give its commits, the PR says
  "No receipt" and that nothing is attested, so silence never reads as proof.
