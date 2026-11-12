// Ported from cline/cline@50e77bc sdk/packages/core/src/extensions/tools/command-guard.ts

package local

import (
	"fmt"
	"regexp"
	"strings"
)

// The shell prefilter for plan runs. It is a denylist, not a shell interpreter, and it is defence
// in depth only: `python -c "open(f, 'w')"` or a command inside a quoted `bash -c` string passes
// it. The sandbox (pkg/sandbox) stays the isolation boundary, and a plan run also has no edit tool.

var blockedCommands = setOf(
	"rm", "rmdir", "unlink", "mv", "cp", "dd", "touch", "mkdir", "ln", "link", "chmod", "chown", "chgrp",
	"truncate", "shred", "install", "patch", "rsync", "mkfifo", "mknod",
	"del", "erase", "move", "ren", "rename", "md", "rd", "mklink", "copy", "xcopy", "robocopy",
	"new-item", "ni", "remove-item", "move-item", "copy-item", "rename-item", "set-content", "add-content",
	"clear-content", "out-file", "mi", "ri", "cpi", "rni", "ac", "clc",
)

var (
	nodePM   = setOf("install", "i", "ci", "add", "remove", "rm", "uninstall", "unlink", "link", "update", "up", "upgrade", "dedupe", "prune", "publish")
	pipSub   = setOf("install", "uninstall", "add", "remove")
	systemPM = setOf("install", "reinstall", "remove", "purge", "uninstall", "upgrade", "autoremove", "add", "del")
	gitSub   = setOf("add", "am", "apply", "checkout", "cherry-pick", "clean", "clone", "commit", "init", "merge", "mv", "pull", "push",
		"rebase", "reset", "restore", "revert", "rm", "stash", "submodule", "switch", "worktree")
	cargoSub = setOf("add", "remove", "rm", "install", "uninstall", "update", "new", "init", "publish")
	gemSub   = setOf("install", "uninstall", "update", "cleanup")
	compSub  = setOf("install", "require", "remove", "update")
	goSub    = setOf("install", "get")
	dotnet   = setOf("add", "remove")
	winget   = setOf("install", "uninstall", "upgrade")
	nuget    = setOf("install", "update", "delete", "push")
)

var blockedSubcommands = map[string]map[string]bool{
	"git": gitSub, "npm": nodePM, "pnpm": nodePM, "yarn": nodePM, "bun": nodePM,
	"pip": pipSub, "pip3": pipSub, "pipx": pipSub, "uv": pipSub, "cargo": cargoSub,
	"apt": systemPM, "apt-get": systemPM, "dnf": systemPM, "yum": systemPM, "apk": systemPM, "brew": systemPM, "snap": systemPM,
	"gem": gemSub, "composer": compSub, "go": goSub, "dotnet": dotnet, "winget": winget, "nuget": nuget,
}

// readOnlyGitForms are the inspecting forms of otherwise mutating git subcommands.
var readOnlyGitForms = map[string]map[string]bool{
	"stash": setOf("list", "show"), "worktree": setOf("list"), "submodule": setOf("status", "summary"),
}

var guardWrappers = setOf("sudo", "doas", "env", "command", "builtin", "nohup", "time", "nice", "stdbuf", "timeout", "xargs")

var reservedWords = setOf("if", "then", "else", "elif", "fi", "while", "until", "do", "done", "for", "case", "esac", "!", "{", "}")

var (
	envAssignment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*\+?=`)
	devSink       = regexp.MustCompile(`(?i)^(/dev/(null|stdout|stderr|tty)|nul:?)$`)
	winTemp       = regexp.MustCompile(`(?i)^(%te?mp%|\$env:te?mp)`)
	waitOrCount   = regexp.MustCompile(`^\d+[smhd]?$`)
	heredoc       = regexp.MustCompile(`(?:^|[^<])<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_./-]+))`)
	arithmetic    = regexp.MustCompile(`\$\(\([\s\S]*?\)\)`)
	escaped       = regexp.MustCompile(`\\.`)
	quoted        = regexp.MustCompile(`"[^"]*"|'[^']*'`)
	quotedSpecial = regexp.MustCompile("[\\s<>|;&$()`#\\\\]")
	comment       = regexp.MustCompile(`(?m)(?:^|\s)#.*$`)
	redirect      = regexp.MustCompile(`(?:^|[^<>])(?:>{1,2}|&>{1,2})\s*([^\s;&|<>()]+)`)
	segmentSplit  = regexp.MustCompile("[\n;|&()`]+")
	inPlaceFlag   = regexp.MustCompile(`^-[A-Za-z]*i(\..*)?$`)
	pythonName    = regexp.MustCompile(`^python[\d.]*$`)
	awkName       = regexp.MustCompile(`^[gnm]?awk$`)
	gitValueFlag  = regexp.MustCompile(`^-[cC]$`)
	curlShortOut  = regexp.MustCompile(`^-[A-Za-z]*[oO]`)
	wgetStdout    = regexp.MustCompile(`^-[A-Za-z]*O-$`)
)

func allowedRedirectTarget(raw string) bool {
	target := strings.NewReplacer(`"`, "", `'`, "").Replace(raw)
	if devSink.MatchString(target) {
		return true
	}
	if strings.Contains(target, "..") {
		return false
	}
	return strings.HasPrefix(target, "/tmp/") || strings.HasPrefix(target, "/var/tmp/") ||
		strings.HasPrefix(target, "$TMPDIR") || strings.HasPrefix(target, "${TMPDIR") || winTemp.MatchString(target)
}

func commandName(word string) string {
	w := strings.NewReplacer(`"`, "", `'`, "").Replace(word)
	if i := strings.LastIndexAny(w, `/\`); i >= 0 {
		w = w[i+1:]
	}
	return strings.TrimSuffix(strings.ToLower(w), ".exe")
}

// maskNonCommandText drops heredoc bodies and blanks the special characters inside quotes, after
// escapes and after comment markers, so the scan cannot trip on data.
func maskNonCommandText(command string) string {
	var kept []string
	delim, open := "", false
	for _, line := range strings.Split(command, "\n") {
		if open {
			if strings.TrimLeft(line, "\t") == delim {
				open = false
			}
			continue
		}
		kept = append(kept, line)
		if m := heredoc.FindStringSubmatch(line); m != nil {
			delim, open = m[1]+m[2]+m[3], true
		}
	}
	s := strings.Join(kept, "\n")
	s = arithmetic.ReplaceAllString(s, "_")
	s = escaped.ReplaceAllString(s, "_")
	s = quoted.ReplaceAllStringFunc(s, func(span string) string { return quotedSpecial.ReplaceAllString(span, "_") })
	return comment.ReplaceAllString(s, " ")
}

func checkTokens(tokens []string) string {
	i := 0
	for i < len(tokens) && (envAssignment.MatchString(tokens[i]) || reservedWords[tokens[i]]) {
		i++
	}
	for i < len(tokens) && guardWrappers[commandName(tokens[i])] {
		i++
		for i < len(tokens) && (strings.HasPrefix(tokens[i], "-") || tokens[i] == "{}" || envAssignment.MatchString(tokens[i]) || waitOrCount.MatchString(tokens[i])) {
			i++
		}
	}
	if i >= len(tokens) {
		return ""
	}
	name, args := commandName(tokens[i]), tokens[i+1:]

	if name == "tee" {
		for _, a := range args {
			if !strings.HasPrefix(a, "-") && !allowedRedirectTarget(a) {
				return "`tee`"
			}
		}
		return ""
	}
	if blockedCommands[name] {
		return "`" + name + "`"
	}
	if subs, ok := blockedSubcommands[name]; ok {
		return checkSubcommand(name, args, subs)
	}
	if pythonName.MatchString(name) {
		return checkPythonPip(args)
	}
	return checkTool(name, args)
}

func checkSubcommand(name string, args []string, subs map[string]bool) string {
	if name == "git" {
		for _, a := range args {
			if a == "--help" || a == "-h" {
				return ""
			}
		}
	}
	cur := 0
	for cur < len(args) && strings.HasPrefix(args[cur], "-") {
		if name == "git" && gitValueFlag.MatchString(args[cur]) {
			cur += 2
		} else {
			cur++
		}
	}
	if cur < len(args) {
		sub := strings.ToLower(args[cur])
		if subs[sub] {
			if name == "git" && cur+1 < len(args) && readOnlyGitForms[sub][strings.ToLower(args[cur+1])] {
				return ""
			}
			return "`" + name + " " + sub + "`"
		}
	}
	if name == "yarn" && len(args) == 0 {
		return "`yarn` (install)"
	}
	return ""
}

func checkPythonPip(args []string) string {
	for mi, a := range args {
		if a != "-m" {
			continue
		}
		if mi+1 < len(args) && (strings.EqualFold(args[mi+1], "pip") || strings.EqualFold(args[mi+1], "pip3")) {
			for _, r := range args[mi+2:] {
				if !strings.HasPrefix(r, "-") {
					if sub := strings.ToLower(r); pipSub[sub] {
						return "`pip " + sub + "`"
					}
					break
				}
			}
		}
		break
	}
	return ""
}

func hasArg(args []string, pred func(i int, a string) bool) bool {
	for i, a := range args {
		if pred(i, a) {
			return true
		}
	}
	return false
}

func checkTool(name string, args []string) string {
	switch {
	case name == "sed" || name == "gsed":
		if hasArg(args, func(_ int, a string) bool { return inPlaceFlag.MatchString(a) || strings.HasPrefix(a, "--in-place") }) {
			return "`sed -i` (in-place edit)"
		}
	case name == "perl":
		if hasArg(args, func(_ int, a string) bool { return inPlaceFlag.MatchString(a) }) {
			return "`perl -i` (in-place edit)"
		}
	case awkName.MatchString(name):
		if hasArg(args, func(i int, a string) bool {
			next := ""
			if i+1 < len(args) {
				next = args[i+1]
			}
			return ((a == "-i" || a == "--include") && strings.HasPrefix(next, "inplace")) ||
				(strings.HasPrefix(a, "-i") && strings.HasPrefix(a[2:], "inplace")) || strings.HasPrefix(a, "--include=inplace")
		}) {
			return "`awk -i inplace` (in-place edit)"
		}
	case name == "sort":
		if hasArg(args, func(_ int, a string) bool { return strings.HasPrefix(a, "-o") || strings.HasPrefix(a, "--output") }) {
			return "`sort -o` (writes a file)"
		}
	case name == "curl":
		if hasArg(args, func(_ int, a string) bool {
			return (!strings.HasPrefix(a, "--") && curlShortOut.MatchString(a)) || strings.HasPrefix(a, "--output") || strings.HasPrefix(a, "--remote-name")
		}) {
			return "`curl -o` (writes a file)"
		}
	case name == "wget":
		if !hasArg(args, func(i int, a string) bool {
			return a == "--spider" || wgetStdout.MatchString(a) || a == "--output-document=-" || (a == "-O" && i+1 < len(args) && args[i+1] == "-")
		}) {
			return "`wget` (downloads files)"
		}
	case name == "find":
		return checkFind(args)
	}
	return ""
}

func checkFind(args []string) string {
	for _, a := range args {
		if a == "-delete" {
			return "`find -delete`"
		}
	}
	for i, a := range args {
		if a != "-exec" && a != "-execdir" && a != "-ok" && a != "-okdir" {
			continue
		}
		var tail []string
		for _, t := range args[i+1:] {
			if t == ";" || t == "+" {
				break
			}
			tail = append(tail, t)
		}
		if r := checkTokens(tail); r != "" {
			return r
		}
	}
	return ""
}

// FindFileEditingCommand returns a short description of the first file-modifying construct in a
// shell command line, or "" when it looks read-only. It is a denylist and defence in depth only:
// the sandbox is the isolation boundary, so a command it passes is not thereby safe.
func FindFileEditingCommand(command string) string {
	masked := maskNonCommandText(command)
	for _, m := range redirect.FindAllStringSubmatch(masked, -1) {
		if !allowedRedirectTarget(m[1]) {
			return fmt.Sprintf("output redirection (`> %s`)", m[1])
		}
	}
	for _, seg := range segmentSplit.Split(masked, -1) {
		if r := checkTokens(strings.Fields(seg)); r != "" {
			return r
		}
	}
	return ""
}
