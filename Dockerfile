# VM run mode (plan "Run anywhere"): `docker build -t software-factory .`,
# then `docker run -d --env-file factory.env -v factory-data:/data
# -p 127.0.0.1:4100:4100 software-factory up --repo owner/name`.
#
# Every tool the loop shells out to is pinned here, not resolved from
# whatever the base image happens to carry: git (worktrees, claim/push), gh
# (issues/PRs, and `gh auth setup-git` in the entrypoint), jq (skills read
# artifact json with it), python3 (guard-paths.sh fails closed without it —
# audit finding #13), uv/uvx (`make check`'s skills-ref validate), and
# node+npm (Claude Code's own npm package needs a node runtime; bun does not
# run its postinstall).
FROM oven/bun:1.3.4-slim

ARG GH_CLI_VERSION=2.63.2
ARG NODE_MAJOR=20
# Which agent CLIs the image carries. Every version below equals its preset's `version`
# (tests/agents-registry.test.ts). Cursor has no versioned download, so it is host-only.
ARG AGENTS="claude codex gemini opencode"
ARG CLAUDE_CODE_VERSION=2.1.286
ARG CODEX_VERSION=0.156.1
ARG GEMINI_VERSION=0.61.0
ARG OPENCODE_VERSION=1.18.32
ARG PI_VERSION=0.73.1
ARG MASTRACODE_VERSION=0.42.0
ARG UV_VERSION=0.5.11

RUN apt-get update && apt-get install -y --no-install-recommends \
      git jq python3 tmux ca-certificates curl gnupg xz-utils \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_${arch}.tar.gz" \
       -o /tmp/gh.tar.gz \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && mv "/tmp/gh_${GH_CLI_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh \
    && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-$(uname -m)-unknown-linux-gnu.tar.gz" \
       -o /tmp/uv.tar.gz \
    && tar -xzf /tmp/uv.tar.gz -C /tmp \
    && mv /tmp/uv-*/uv /tmp/uv-*/uvx /usr/local/bin/ \
    && rm -rf /tmp/gh* /tmp/uv* \
    && apt-get purge -y curl gnupg xz-utils && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

RUN set -e; for agent in $AGENTS; do \
      case "$agent" in \
        claude) pkg="@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" ;; \
        codex) pkg="@openai/codex@${CODEX_VERSION}" ;; \
        gemini) pkg="@google/gemini-cli@${GEMINI_VERSION}" ;; \
        opencode) pkg="opencode-ai@${OPENCODE_VERSION}" ;; \
        pi) pkg="@mariozechner/pi-coding-agent@${PI_VERSION}" ;; \
        mastracode) pkg="mastracode@${MASTRACODE_VERSION}" ;; \
        *) echo "unknown agent $agent (cursor is host-only)" >&2; exit 1 ;; \
      esac; \
      npm install -g "$pkg"; \
    done

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY bin ./bin
COPY src ./src
COPY dashboard ./dashboard
COPY template ./template
COPY template-ci ./template-ci
COPY install.sh ./install.sh
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# All runner state — clones, worktrees, the SQLite telemetry cache — lives
# under FACTORY_HOME (src/paths.ts), so a single named volume is the whole
# durability story (audit finding #1: no more relative-path ambiguity).
ENV FACTORY_HOME=/data
VOLUME ["/data"]
EXPOSE 4100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["--help"]
