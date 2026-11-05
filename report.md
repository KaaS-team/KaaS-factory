BRANCH: cluster/v7.0-enterprise-package
HEAD: 17496e6df116d5da3e0d0e6c8f45e06c37813de1
## Summary
ee/ is now a package (package.json, plugin.json) and an `extension` plugin kind the loader runs. The core builds and starts with ee/ deleted, and a structural test catches a core import of the package by path or name.
## Issues
- #592: done.
  - Own package loaded through the plugin loader -> ee/tests/plugin.test.ts "ee/ is a package whose manifest the plugin loader accepts and runs" -> tests/mutations/an-extension-plugin-is-loaded-without-running-it.json
  - Core builds, tests and ships without ee -> tests/enterprise-package.test.ts "the core builds and runs `factory version` with ee/ deleted" -> tests/mutations/the-core-cannot-start-without-ee-present.json
  - Structural test fails if the core imports the package -> tests/licensing.test.ts "nothing outside ee/ imports from ee/" (now also matches @kaas-team/factory-enterprise) -> tests/mutations/the-core-imports-the-enterprise-package-by-name.json (the older path mutation still holds)
## Staged workflow changes
none
## Checkpoints
#592: 1 to 7 all yes except area (see below). Ran the changed tests with --rerun-each 3: 93 pass.
## Files outside my area
- src/plugins/registry.ts, src/plugins/loader.ts: add the `extension` kind (the plugin spine had no kind for non-agent features).
- tests/plugin-loader.test.ts: kind list in an existing assertion. tests/licensing.test.ts, tests/enterprise-package.test.ts: the core-side structural tests. tests/mutations/*.json: three new mutation files.
## Gate evidence
make fast: ok
## Risk and rollback
Low. Adds a kind; ee/register.ts (Docker preload) behaves as before. Revert the single commit.
## Learnings
- Did not move ee/ to packages/: Dockerfile, docker-entrypoint.sh, REUSE.toml, biome.json, tsconfig and tests/deploy.test.ts all name ee/ and are outside my area. Moving it is a follow-up.
- bun build needs --outdir, not --outfile, for bin/factory.
- biome formats the test file; run bunx biome check --write before make fast.
