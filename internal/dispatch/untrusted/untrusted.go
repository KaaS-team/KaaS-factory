// Ported from anthropics/claude-code-action@8a29bc6 src/github/validation/untrusted-pr.ts
// MIT, Copyright (c) Anthropic, PBC, 2025. Ported to Go by hand.

// Package untrusted holds the rules for a session that works on a pull request whose author
// lacks write access: a deny list for commands that run code from the checkout, and a guard that
// puts the files the agent CLI and git trust back after the session.
package untrusted

import (
	"context"
	"strings"
)

// Access looks up a repository collaborator's permission level (admin, write, read, none).
type Access interface {
	Permission(ctx context.Context, user string) (string, error)
}

// disallowed are commands that run code from the checkout. Deny rules beat allow rules, so
// they stay blocked even when the brief allows them. Each has the form Bash(<command>:*).
var disallowed = []string{
	"Bash(bun:*)", "Bash(bunx:*)", "Bash(deno:*)", "Bash(jest:*)", "Bash(node:*)", "Bash(npm:*)",
	"Bash(npx:*)", "Bash(pnpm:*)", "Bash(ts-node:*)", "Bash(tsx:*)", "Bash(vitest:*)", "Bash(yarn:*)",
	"Bash(hatch:*)", "Bash(nox:*)", "Bash(pip:*)", "Bash(pip3:*)", "Bash(pipenv:*)", "Bash(poetry:*)",
	"Bash(pytest:*)", "Bash(python:*)", "Bash(python3:*)", "Bash(tox:*)", "Bash(uv:*)", "Bash(uvx:*)",
	"Bash(bundle:*)", "Bash(cargo:*)", "Bash(cmake:*)", "Bash(composer:*)", "Bash(docker:*)",
	"Bash(dotnet:*)", "Bash(go:*)", "Bash(gradle:*)", "Bash(./gradlew:*)", "Bash(java:*)",
	"Bash(just:*)", "Bash(make:*)", "Bash(mvn:*)", "Bash(./mvnw:*)", "Bash(perl:*)", "Bash(php:*)",
	"Bash(rake:*)", "Bash(rspec:*)", "Bash(ruby:*)", "Bash(task:*)",
	"Bash(bash:*)", "Bash(dash:*)", "Bash(sh:*)", "Bash(zsh:*)",
	"Bash(git config:*)", "Bash(git -c:*)",
}

// Deny returns the tools to deny for a pull request by author, or nil when the author has
// write access. A bot, a missing author and a failed lookup all count as untrusted.
func Deny(ctx context.Context, a Access, author string) []string {
	if author == "" || strings.HasSuffix(author, "[bot]") {
		return append([]string(nil), disallowed...)
	}
	level, err := a.Permission(ctx, author)
	if err == nil && (level == "admin" || level == "write") {
		return nil
	}
	return append([]string(nil), disallowed...)
}

// MergeDeny returns argv with deny added to its --disallowedTools value, adding the flag when
// argv has none. argv itself is not changed.
func MergeDeny(argv, deny []string) []string {
	out := append([]string(nil), argv...)
	list := strings.Join(deny, ",")
	for i := 0; i+1 < len(out); i++ {
		if out[i] == "--disallowedTools" {
			out[i+1] += "," + list
			return out
		}
	}
	return append(out, "--disallowedTools", list)
}
