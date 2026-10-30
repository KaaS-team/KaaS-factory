# Contributing

Changes come in as pull requests. Every commit carries a Developer Certificate of Origin sign-off
(https://developercertificate.org), added by `git commit -s`:

    Signed-off-by: Your Name <you@example.com>

The address must be the commit's author address. CI runs `bun scripts/dco.ts` on every pull request
and names any commit that lacks one; fix it with `git rebase --signoff origin/main`.

A pull request body fills every section of `.github/pull_request_template.md` (Summary, Plan, Gate evidence,
Verify verdict, Risk and rollback), or has the factory's own What changed and Acceptance sections.
CI runs `bun scripts/check-pr-body.ts` and names any section that is missing or empty.

A pull request that only changes tests, deletes a test, removes an assertion, adds a skip or loosens a matcher
carries a `Test change reason:` line in its body, at least ten characters, saying why. CI runs
`bun scripts/check-tests-only.ts` and names each change it found when the line is missing.

A test that flips in the nightly `flakes` run three times (`FLAKE_LIMIT`) must be tagged `@quarantine` and get an
entry in `tests/quarantine.json` with an owner and an expiry within 30 days. `tests/quarantine.test.ts` fails on a
tag with no entry or an expired one.

The core is Apache-2.0 (LICENSE) and there is no CLA. Code under `ee/` is written by the KaaS team
only and is not open for contributions. `make check` must pass with zero errors and zero warnings.
