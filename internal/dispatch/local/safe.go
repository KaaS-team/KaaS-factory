package local

import (
	"regexp"
	"strings"
)

// Ported by hand from src/safe-outputs.ts at ts-final. A repo's extra shell
// patterns are held to an allowlist of shapes, since a denylist of commands
// is bypassed by any wrapper.

var wrappers = setOf("env", "bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "exec", "sudo", "doas", "nohup", "timeout",
	"xargs", "command", "builtin", "source", ".", "nice", "time", "watch", "parallel", "script",
	"node", "bun", "bunx", "npx", "pnpx", "deno", "perl", "ruby", "php", "lua", "osascript")
var outward = setOf("gh", "hub", "glab", "curl", "wget", "nc", "ncat", "ssh", "scp", "sftp", "rsync", "ftp")
var outwardGit = setOf("push", "remote", "send-email", "credential", "config", "request-pull", "submodule")
var publish = setOf("npm", "pnpm", "yarn", "cargo", "twine", "gem", "poetry")
var gitValue = setOf("-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env")

var (
	interpreter  = regexp.MustCompile(`^(python|pypy|node|ruby|perl|php)[\d.]*$`)
	shellSyntax  = regexp.MustCompile("[;&|`$()<>\\\\\n'\"]")
	trailingStar = regexp.MustCompile(`(\s\*|:\*)$`)
)

func setOf(s ...string) map[string]bool {
	m := make(map[string]bool, len(s))
	for _, v := range s {
		m[v] = true
	}
	return m
}

// refused reports whether pattern is not an allowed command shape.
func refused(pattern string) bool {
	p := strings.ToLower(strings.TrimSpace(pattern))
	body := trailingStar.ReplaceAllString(p, "")
	if strings.Contains(body, "*") || shellSyntax.MatchString(body) {
		return true
	}
	words := strings.Fields(body)
	if len(words) == 0 {
		return true
	}
	argv0 := words[0]
	if strings.Contains(argv0, "/") || strings.Contains(argv0, "=") || wrappers[argv0] || interpreter.MatchString(argv0) || outward[argv0] {
		return true
	}
	if publish[argv0] {
		for _, w := range words {
			if w == "publish" {
				return true
			}
		}
	}
	if argv0 == "git" {
		i := 1
		for i < len(words) && strings.HasPrefix(words[i], "-") {
			w := words[i]
			if w == "-c" || strings.HasPrefix(w, "--config-env") {
				return true
			}
			if gitValue[w] {
				i += 2
			} else {
				i++
			}
		}
		sub := ""
		if i < len(words) {
			sub = words[i]
		}
		if sub != "" && outwardGit[sub] {
			return true
		}
		if p != body && sub == "" {
			return true
		}
	}
	return false
}

func safeCommands(patterns []string) []string {
	var out []string
	for _, p := range patterns {
		if !refused(p) {
			out = append(out, p)
		}
	}
	return out
}
