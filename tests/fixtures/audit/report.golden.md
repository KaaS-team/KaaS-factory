# Repo audit

## Scores

- repo: 43/100 (3 of 7 checks pass)
- process: 0/100 (0 of 6 checks pass)
- prs: 50/100 (2 of 4 checks pass)

## Findings

- [high] prs-tests: Most code changes ship without a test. 3 of 4 code PRs touched no test.
- [high] repo-ci: No CI configuration. no workflow under .github/workflows, no .gitlab-ci.yml or .circleci.
- [high] repo-env: A .env file is committed. .env is tracked in the repo.
- [medium] process-owners: No CODEOWNERS. no CODEOWNERS file.
- [medium] process-pr-template: No pull request template. no pull_request_template.md.
- [medium] prs-reverts: Frequent reverts. 1 of 5 PRs are reverts.
- [medium] repo-lockfile: No lockfile. no lockfile at the repo root.
- [low] process-agent-rules: No agent instructions. no AGENTS.md or CLAUDE.md.
- [low] process-contributing: No contributing guide. no CONTRIBUTING file.
- [low] process-issue-templates: No issue templates. no .github/ISSUE_TEMPLATE.
- [low] process-security: No security policy. no SECURITY file.
- [low] repo-license: No license file. no LICENSE at the repo root.

## Fixes

- prs-tests: Require a test change in every code PR and check it in CI.
- repo-ci: Add a CI job that runs the tests on every pull request.
- repo-env: Remove it from history, rotate what it held, and commit a .env.example instead.
- process-owners: Name an owner for each area so reviews have a default reader.
- process-pr-template: Add a template that asks what changed, why, and how it was tested.
- prs-reverts: Find what lets breaking changes merge, and gate on it before merge.
- repo-lockfile: Commit the lockfile so installs match across machines.
- process-agent-rules: Record the commands and rules a coding agent must follow.
- process-contributing: Write down how to branch, test and ask for review.
- process-issue-templates: Add a bug and a task template so issues arrive with the facts a build needs.
- process-security: Say where to report a vulnerability.
- repo-license: Add the license the owners intend, or state that the code is private.

## Plan

1. Week 1: stop the risks: prs-tests, repo-ci, repo-env
2. Weeks 2 to 3: close the process gaps: process-owners, process-pr-template, prs-reverts, repo-lockfile
3. Later: tidy: process-agent-rules, process-contributing, process-issue-templates, process-security, repo-license
