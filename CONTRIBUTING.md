# Contributing

Changes come in as pull requests. Every commit carries a Developer Certificate of Origin sign-off
(https://developercertificate.org), added by `git commit -s`:

    Signed-off-by: Your Name <you@example.com>

The address must be the commit's author address. CI runs `go run ./tools/prcheck dco` on every pull request
and names any commit that lacks one; fix it with `git rebase --signoff origin/main`.

A pull request body fills every section of `.github/pull_request_template.md` (Summary, Plan, Gate evidence,
Verify verdict, Confidence, Risk and rollback), or has the factory's own What changed and Acceptance sections.
CI runs `go run ./tools/prcheck body` and names any section that is missing or empty.

A pull request that only changes tests, deletes a test, removes an assertion, adds a skip or loosens a matcher
carries a `Test change reason:` line in its body, at least ten characters, saying why. CI runs
`go run ./tools/prcheck tests-only` and names each change it found when the line is missing.

The core is Apache-2.0 (LICENSE) and there is no CLA. Code under `ee/` is written by the KaaS team
only and is not open for contributions. `just check` must pass with zero errors and zero warnings.

## Who opens what

Bugs and ideas go through issues, in the planned format of `.github/ISSUE_TEMPLATE/`. Implementation pull
requests come from maintainers (owner, member, collaborator) and the logins in `.github/approved-contributors.json`.
A pull request from anyone else is closed with a pointer back here. A maintainer labels new issues by hand.
Report a vulnerability as in SECURITY.md.
