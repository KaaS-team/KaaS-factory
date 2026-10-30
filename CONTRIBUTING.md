# Contributing

Changes come in as pull requests. Every commit carries a Developer Certificate of Origin sign-off
(https://developercertificate.org), added by `git commit -s`:

    Signed-off-by: Your Name <you@example.com>

The address must be the commit's author address. CI runs `bun scripts/dco.ts` on every pull request
and names any commit that lacks one; fix it with `git rebase --signoff origin/main`.

A pull request body fills every section of `.github/pull_request_template.md` (Summary, Plan, Gate evidence,
Verify verdict, Risk and rollback), or has the factory's own What changed and Acceptance sections.
CI runs `bun scripts/check-pr-body.ts` and names any section that is missing or empty.

The core is Apache-2.0 (LICENSE) and there is no CLA. Code under `ee/` is written by the KaaS team
only and is not open for contributions. `make check` must pass with zero errors and zero warnings.
