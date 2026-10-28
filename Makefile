.PHONY: agent-matrix install check check-mutations quarantine lint typecheck test skills-check up watch dashboard reset doctor scan

install:
	bun install

# make check = lint (biome, and rustfmt plus clippy on verify/ and relay/) + typecheck + test + skills validation. Hard-fails if uvx is
# missing rather than skipping skills-ref: an unwired or silently-skipped
# check did not ship (see the kaas-eng plugin's engineering.md, Rule 0).
check: lint typecheck test skills-check
	@echo "make check: ok"

# reuse lint checks every file's licence against REUSE.toml (tests/licensing.test.ts checks what it says).
# Biome is the one formatter and linter. The rules biome.json turns off are house idioms
# (`!` in tests, comma and forEach shorthand, literal `${}` in test strings).
lint:
	bun x biome ci .
	uvx reuse==6.2.0 lint --quiet
	@command -v cargo >/dev/null 2>&1 || { echo "make check: cargo is required for verify/ and relay/, not skipping them" >&2; exit 1; }
	cargo fmt --manifest-path verify/Cargo.toml --check
	cargo clippy --quiet --locked --manifest-path verify/Cargo.toml --target-dir $${CARGO_TARGET_DIR:-$${TMPDIR:-/tmp}/kaas-verify-target} -- -D warnings
	cargo fmt --manifest-path relay/Cargo.toml --check
	cargo clippy --quiet --locked --manifest-path relay/Cargo.toml --target-dir $${CARGO_TARGET_DIR:-$${TMPDIR:-/tmp}/kaas-relay-target} -- -D warnings

typecheck:
	bun x tsc --noEmit

# Run with no git identity, like a fresh CI runner or container, so a code path
# that needs the developer's own identity fails here and not only on GitHub.
# A flaky test is named @quarantine: test skips it and writes reports/junit.xml for the CTRF step in ci.yml;
# quarantine, a ci.yml job that never blocks a push, runs only those (bun fails a filter that matches none).
GIT_ENV = GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true
test:
	@mkdir -p reports
	$(GIT_ENV) bun test -t '^(?!.*@quarantine)' --reporter=junit --reporter-outfile=reports/junit.xml

quarantine:
	@f=$$(grep -rl @quarantine tests --include='*.test.ts'); if [ -z "$$f" ]; then echo "quarantine: no @quarantine tests"; \
	else $(GIT_ENV) bun test -t @quarantine $$f; fi

# Each entry in tests/mutations.json breaks one thing; its test must go red.
# Proves the checks bite. Its own CI job, since it copies the repo per mutation.
check-mutations:
	GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun scripts/check-mutations.ts "$(ONLY)"

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

