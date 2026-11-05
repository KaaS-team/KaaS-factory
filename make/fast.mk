# make fast: what CI's first red step would say, in under 30 s, before any push.
# The five steps below were the first failing step in 31 of 34 red PR runs (formatting, test-only changes, mutations, baseline).
BASE ?= origin/main
fast:
	bun x biome ci .
	bun x tsc --noEmit
	bun scripts/check-tests-only.ts $(BASE) HEAD
	@changed=$$(git diff --name-only --diff-filter=AM "$(BASE)...HEAD" -- 'tests/*.test.ts' | tr '\n' ' '); \
	if [ -n "$$changed" ]; then $(MAKE) test FILES="$$changed" TEST_ARGS="--rerun-each 3"; fi
	bun scripts/check-mutations.ts --base $(BASE)
	bun scripts/gen-quality-baseline.ts --check
	bun scripts/check-mutation-anchors.ts
	@echo "make fast: ok"

.PHONY: fast
