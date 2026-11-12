// Ported from anthropics/claude-code-action@8a29bc6 src/github/validation/untrusted-pr.ts
// MIT, Copyright (c) Anthropic, PBC, 2025. Ported to Go by hand.

// Package untrusted holds the rules for a session that works on a pull request whose author
// lacks write access: an allowlist of the commands it may run (everything else is refused, because
// a blocklist misses env, xargs, find -exec and git hooks), a deny list kept as a second layer, and
// a guard that puts the files the agent CLI and git trust back during and after the session.
package untrusted

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	// Commands that start another program, and the git commands that fire hooks.
	"Bash(env:*)", "Bash(xargs:*)", "Bash(find:*)", "Bash(exec:*)", "Bash(nohup:*)", "Bash(timeout:*)",
	"Bash(git commit:*)", "Bash(git checkout:*)", "Bash(git merge:*)", "Bash(git rebase:*)", "Bash(git am:*)",
	"Bash(git push:*)", "Bash(git gc:*)", "Bash(git stash:*)", "Bash(git submodule:*)",
}

// allowed are the only shell commands an untrusted-PR run may execute: read-only git and the
// repo's declared gate command. A pattern ending in " *" takes arguments; any other is exact.
var allowed = []string{
	"git status *", "git diff *", "git log *", "git show *", "git rev-parse *", "git worktree list",
	".factory/gates.sh", ".factory/gates.sh *", "bash .factory/gates.sh", "bash .factory/gates.sh *",
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

// Restrict returns argv for an untrusted run: the deny list merged in, and the settings' allowed
// Bash rules cut to the allowlist. It fails closed: the run must be in dontAsk mode, where a
// command that is not allowed is refused, and argv must carry the settings to cut.
func Restrict(argv, deny []string) ([]string, error) {
	out := MergeDeny(argv, deny)
	dontAsk, set := false, -1
	for i := 0; i+1 < len(out); i++ {
		switch out[i] {
		case "--permission-mode":
			dontAsk = out[i+1] == "dontAsk"
		case "--settings":
			set = i + 1
		}
	}
	if !dontAsk {
		return nil, errors.New("untrusted: the run is not in dontAsk permission mode, so the allowlist would not bind")
	}
	if set < 0 {
		return nil, errors.New("untrusted: argv has no --settings to restrict")
	}
	cut, err := allowOnly(out[set])
	if err != nil {
		return nil, err
	}
	out[set] = cut
	return out, nil
}

func allowOnly(settings string) (string, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(settings), &top); err != nil {
		return "", errors.New("untrusted: --settings is not a JSON object")
	}
	var perms map[string]json.RawMessage
	if raw, ok := top["permissions"]; ok {
		if err := json.Unmarshal(raw, &perms); err != nil {
			return "", errors.New("untrusted: settings permissions are not an object")
		}
	}
	if perms == nil {
		perms = map[string]json.RawMessage{}
	}
	var rules []string
	if raw, ok := perms["allow"]; ok {
		if err := json.Unmarshal(raw, &rules); err != nil {
			return "", errors.New("untrusted: settings permissions.allow is not a list")
		}
	}
	keep := []string{}
	for _, r := range rules {
		inner, isBash := strings.CutPrefix(r, "Bash(")
		if r == "Bash" || (isBash && !allowedRule(strings.TrimSuffix(inner, ")"))) {
			continue
		}
		keep = append(keep, r)
	}
	perms["allow"], _ = json.Marshal(keep)
	top["permissions"], _ = json.Marshal(perms)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(top) // raw messages and string lists always encode
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

func allowedRule(pattern string) bool {
	for _, a := range allowed {
		if pattern == a {
			return true
		}
	}
	return false
}
