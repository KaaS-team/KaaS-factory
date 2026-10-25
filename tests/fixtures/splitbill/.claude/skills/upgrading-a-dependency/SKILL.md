---
name: upgrading-a-dependency
description: Use when a dependency-type issue asks to upgrade a package in splitbill (e.g. hono, nanoid), including major version bumps. Covers reading the changelog first, upgrading one package at a time, and recording breaking changes for the PR.
---

# Upgrading a dependency

## Procedure

1. **Read the changelog or release notes first**, from the currently
   pinned version up to the target version - not just the target's latest
   entry. For a major bump, read the migration guide if one exists.
2. **One package at a time.** Never bundle two dependency upgrades in one
   change; each gets its own issue, branch and PR so a regression is
   traceable to one bump.
3. **List every breaking change you find** that touches this repo's code,
   even ones that turn out not to apply. Check call sites with a repo-wide
   search for the package's name, not just the files you expect to change.
4. **Upgrade, then fix call sites**, don't guess: bump the version in
   `package.json`, run `bun install`, run typecheck - the compiler will
   point at removed or renamed APIs.
5. **Run the gates** (`make check`) before opening the PR. A dependency
   bump with a failing gate is not done.
6. **Write the breaking-change list into the PR** (the PR template's
   Summary section), not just the commit message - the human approving a
   medium/high-risk plan needs it to review the diff quickly.

## Example in this repo

`hono` is pinned to `3.12.12`; the v4 migration guide flags
`HonoRequest.cookie()` and `Context.cookie()` as removed in favor of
`getCookie`/`setCookie` from `hono/cookie`. `src/routes/groups.ts` uses
both. A correct upgrade PR touches `package.json`, that one file, and lists
the cookie-helper change explicitly - it does not touch `src/auth/**`
(protected; a separate concern) unless the changelog says auth-adjacent
APIs moved too.

## Non-goals

Don't upgrade a package the issue didn't name. Don't jump past the
requested target version "while you're in there" - a further bump is a
separate issue.
