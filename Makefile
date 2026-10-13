.PHONY: agent-matrix demo install check check-mutations typecheck test skills-check up watch dashboard reset doctor scan

install:
	bun install

# make check = typecheck + test + skills validation. Hard-fails if uvx is
# missing rather than skipping skills-ref: an unwired or silently-skipped
# check did not ship (see the lwp-eng plugin's engineering.md, Rule 0).
check: typecheck test skills-check
	@echo "make check: ok"

typecheck:
	bun x tsc --noEmit

# Run with no git identity, like a fresh CI runner or container, so a code path
# that needs the developer's own identity fails here and not only on GitHub.
test:
	GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true bun test

# Each entry in tests/mutations.json breaks one thing; its test must go red.
# Proves the checks bite. Its own CI job, since it copies the repo per mutation.
check-mutations:
	GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun scripts/check-mutations.ts

skills-check:
	@command -v uvx >/dev/null 2>&1 || { \
		echo "make check: uvx is required to validate template/.claude/skills (install: https://docs.astral.sh/uv/) — not skipping this check" >&2; \
		exit 1; \
	}
	@for dir in template/.claude/skills/*/; do \
		name="$$(basename "$$dir")"; \
		echo "skills-ref validate: $$name"; \
		uvx --from "git+https://github.com/agentskills/agentskills#subdirectory=skills-ref" skills-ref validate "$$dir" || exit 1; \
	done

# `make up`: run the poller and the dashboard together. Requires
# .factory/config.json in the target repo; --repo-dir defaults to $$PWD.
# `watch` never returns, so it's backgrounded and killed with the dashboard
# on Ctrl+C (trap), rather than listed as a `up: watch dashboard` prereq
# (make would run watch to completion first and never reach dashboard).
up:
	@trap 'kill 0' EXIT INT TERM; \
	bun bin/factory watch --repo-dir "$${REPO_DIR:-.}" $(WATCH_ARGS) & \
	bun bin/factory dashboard --repo-dir "$${REPO_DIR:-.}" & \
	wait

watch:
	bun bin/factory watch --repo-dir "$${REPO_DIR:-.}"

dashboard:
	bun bin/factory dashboard

reset:
	bun bin/factory reset --repo-dir "$${REPO_DIR:-.}" $(if $(DRY_RUN),--dry-run,)

doctor:
	bun bin/factory doctor --repo-dir "$${REPO_DIR:-.}"

scan:
	bun bin/factory scan --repo-dir "$${REPO_DIR:-.}"

# Spends tokens, so it is not part of `make check`. See docs/verify-an-agent.md.
agent-matrix:
	bun scripts/agent-matrix.ts

# The lesson's tmux layout, then attach; RECORD=1 records the attach with asciinema.
demo:
	teach/demo/$${SESSION:-lightning-2}.sh up
	teach/demo/$${SESSION:-lightning-2}.sh $(if $(RECORD),--record,) attach
