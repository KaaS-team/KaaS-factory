# Per-feature make files

The Makefile includes every `make/*.mk`, so two features never edit the same line.

A feature adds `make/<feature>.mk` that holds:

- `.PHONY: <target>`
- the target itself
- `CHECK_EXTRA += <target>` when it belongs in `make check`

It never edits the Makefile.

`tests/make-registry.test.ts` checks that each `check-*` target here is in its own `.PHONY`
and `CHECK_EXTRA` lines.
