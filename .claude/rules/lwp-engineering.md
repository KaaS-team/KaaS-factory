# Engineering standard

A repo's `AGENTS.md` wins where it disagrees, but must say so. The incident behind each rule is in
https://github.com/Param-Harrison/lwp-claude-plugins/blob/main/docs/engineering-why.md; read it only
when you need to argue a rule.

**Rule 0.** A check lands wired into `make check`, the build or CI in the same change. An unwired
check, or a rule stated only in a doc, did not ship.

## Where the rest lives

Path-scoped rules load when a matching file is read: `.claude/rules/lwp-api.md` (routes and services),
`.claude/rules/lwp-db.md` (tables, queries, migrations), `.claude/rules/lwp-comments.md` and
`.claude/rules/lwp-playwright.md`. `sync-vendored.py` copies them into each repo from lwp-claude-plugins.

## Working rules

- Test the structure: one test that walks every route, table or coupled pair beats review.
- Verify by executing (curl it, run it, check the row), then revert the fix and watch the test fail.
- Gate the blast radius: `scripts/lwp/check-affected.py --run` per phase, `--base origin/main` before a PR; the box runs everything on push.
- Never write a claim the code does not do.
- One resolver per concept; a number that appears twice is derived or pinned by a test.
- Vet a dependency before adding it (`/eng-add-dependency`); no major-version drift across sibling apps.
- Infrastructure: fewest moving parts wins. Never applies to the product.
- Operator detail (model names, tokens, spend, hosts, stack traces) never reaches a customer.

## Don'ts

No persona prompts. No rule without a named failure. No second source of truth. No doc longer than
the code it governs. No new file when an existing one will do. Never widen scope; say what you left out.

## Parallel sessions

File-touching work goes in its own worktree. Throwaway files go in the session scratchpad. Secrets never go on a command line.

## Tooling and done

`/eng-audit-repo` scores a repo; `python3 scripts/lwp/check-prose.py <files>`
checks prose (no em dashes, no filler). Done means: the gate passes with zero errors and zero warnings,
the new check is wired, every claim in the diff is asserted, and you ran it.
