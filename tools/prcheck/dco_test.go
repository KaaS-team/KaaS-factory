// Ported from scripts/dco.ts at ts-final
package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitRepo makes a temp repo with one base commit and returns its dir.
func gitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, nil, "init", "-q", "-b", "main")
	git(t, dir, nil, "config", "commit.gpgsign", "false")
	commit(t, dir, "base.txt", "base\n", "base", "Base <base@x.io>")
	return dir
}

func git(t *testing.T, dir string, extraEnv []string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_COMMITTER_NAME=T", "GIT_COMMITTER_EMAIL=t@x.io", "GIT_AUTHOR_NAME=T", "GIT_AUTHOR_EMAIL=t@x.io")
	cmd.Env = append(cmd.Env, extraEnv...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// commit writes file and commits it with message as the given "Name <email>" author.
func commit(t *testing.T, dir, file, content, message, author string) string {
	t.Helper()
	path := filepath.Join(dir, file)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, nil, "add", "-A")
	git(t, dir, nil, "commit", "-q", "--author", author, "-m", message)
	return git(t, dir, nil, "rev-parse", "HEAD")
}

func TestUnsigned(t *testing.T) {
	signed := Commit{"a", "dev@x.io", "fix\n\nSigned-off-by: Dev <dev@x.io>\n"}
	missing := Commit{"b", "dev@x.io", "fix\n"}
	someoneElse := Commit{"c", "dev@x.io", "fix\n\nSigned-off-by: Other <other@x.io>\n"}
	quoted := Commit{"d", "dev@x.io", "fix: mention Signed-off-by: Dev <dev@x.io> inline\n"}
	bot := Commit{"e", "49699333+dependabot[bot]@users.noreply.github.com", "bump\n"}
	var got []string
	for _, c := range unsigned([]Commit{signed, missing, someoneElse, quoted, bot}) {
		got = append(got, c.SHA)
	}
	if strings.Join(got, ",") != "b,c,d" {
		t.Fatalf("unsigned = %v, want [b c d]", got)
	}
}

func TestDCO(t *testing.T) {
	cases := []struct {
		name     string
		message  string
		wantCode int
		wantOut  string
	}{
		{"signed by the author passes", "fix\n\nSigned-off-by: Dev <dev@x.io>", 0, "dco: every commit in main..HEAD is signed off"},
		{"address case is ignored", "fix\n\nSigned-off-by: Dev <DEV@x.io>", 0, "is signed off"},
		{"no trailer fails and names the commit", "fix", 1, "has no Signed-off-by for dev@x.io (git commit -s)"},
		{"someone else's trailer fails", "fix\n\nSigned-off-by: Other <other@x.io>", 1, "has no Signed-off-by for dev@x.io"},
		{"a quoted trailer mid-line fails", "fix: Signed-off-by: Dev <dev@x.io> inline", 1, "has no Signed-off-by for dev@x.io"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := gitRepo(t)
			git(t, dir, nil, "branch", "base")
			sha := commit(t, dir, "f.txt", "x\n", tc.message, "Dev <dev@x.io>")
			var out, errb bytes.Buffer
			code := run(dir, []string{"dco", "base", "HEAD"}, func(string) string { return "" }, &out, &errb)
			all := out.String() + errb.String()
			if code != tc.wantCode || !strings.Contains(all, strings.ReplaceAll(tc.wantOut, "main..HEAD", "base..HEAD")) {
				t.Fatalf("code %d, output %q; want code %d containing %q", code, all, tc.wantCode, tc.wantOut)
			}
			if tc.wantCode == 1 && !strings.Contains(errb.String(), sha[:7]) {
				t.Fatalf("stderr %q does not start the line with %s", errb.String(), sha[:7])
			}
		})
	}
}

func TestDCOSkipsMergeCommitsAndNamesEveryBadCommit(t *testing.T) {
	dir := gitRepo(t)
	git(t, dir, nil, "branch", "base")
	git(t, dir, nil, "checkout", "-q", "-b", "side")
	commit(t, dir, "s.txt", "s\n", "side one", "Dev <dev@x.io>")
	git(t, dir, nil, "checkout", "-q", "main")
	commit(t, dir, "m.txt", "m\n", "main one\n\nSigned-off-by: Dev <dev@x.io>", "Dev <dev@x.io>")
	git(t, dir, nil, "merge", "-q", "--no-ff", "-m", "merge side", "side")
	var out, errb bytes.Buffer
	code := run(dir, []string{"dco", "base", "HEAD"}, func(string) string { return "" }, &out, &errb)
	if code != 1 || strings.Count(errb.String(), "has no Signed-off-by") != 1 {
		t.Fatalf("code %d, stderr %q: want exactly the side commit named, the merge skipped", code, errb.String())
	}
}

func TestDCOUsageAndBadRange(t *testing.T) {
	dir := gitRepo(t)
	var out, errb bytes.Buffer
	if code := run(dir, []string{"dco"}, func(string) string { return "" }, &out, &errb); code != 2 || !strings.Contains(errb.String(), "usage: prcheck dco <base> [head]") {
		t.Fatalf("no args: code %d, stderr %q", code, errb.String())
	}
	errb.Reset()
	if code := run(dir, []string{"dco", "nope", "HEAD"}, func(string) string { return "" }, &out, &errb); code != 2 || !strings.Contains(errb.String(), "git log nope..HEAD") {
		t.Fatalf("bad base: code %d, stderr %q", code, errb.String())
	}
}

// The pre-push hook checks only what the push sends: commits already on the remote were checked
// when they landed, so an old unsigned one there must not block every later push.
func TestDCOUnpushedSkipsCommitsOnTheRemote(t *testing.T) {
	remote := gitRepo(t)
	dir := t.TempDir()
	git(t, dir, nil, "clone", "-q", remote, ".")
	git(t, dir, nil, "config", "commit.gpgsign", "false")
	commit(t, dir, "old.txt", "o\n", "old unsigned", "Dev <dev@x.io>")
	git(t, dir, nil, "push", "-q", "origin", "HEAD:refs/heads/next")
	git(t, dir, nil, "fetch", "-q", "origin")
	signed := commit(t, dir, "new.txt", "n\n", "new\n\nSigned-off-by: Dev <dev@x.io>", "Dev <dev@x.io>")
	var out, errb bytes.Buffer
	if code := run(dir, []string{"dco", "--unpushed"}, func(string) string { return "" }, &out, &errb); code != 0 {
		t.Fatalf("signed local commit on top of a pushed unsigned one: code %d, stderr %q", code, errb.String())
	}
	if !strings.Contains(out.String(), "every unpushed commit is signed off") {
		t.Fatalf("stdout %q", out.String())
	}
	bad := commit(t, dir, "bad.txt", "b\n", "new unsigned", "Dev <dev@x.io>")
	out.Reset()
	errb.Reset()
	code := run(dir, []string{"dco", "--unpushed"}, func(string) string { return "" }, &out, &errb)
	if code != 1 || !strings.Contains(errb.String(), bad[:7]) || strings.Contains(errb.String(), signed[:7]) {
		t.Fatalf("unsigned local commit: code %d, stderr %q; want code 1 naming only %s", code, errb.String(), bad[:7])
	}
}
