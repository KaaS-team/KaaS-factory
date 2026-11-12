package packs

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

var update = flag.Bool("update", false, "rewrite golden files")

const (
	agplText = "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3\n"
	ccText   = "Creative Commons Attribution-ShareAlike 4.0 International\n"
)

// run executes cmd with args and returns its output and error.
func run(t *testing.T, cmd *cobra.Command, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), err
}

func addCmd(u *upstreamRepo) *cobra.Command {
	return newAddCommand(func(cache string) Fetcher {
		return GitFetcher{Remote: func(string) string { return u.bare }, Cache: cache}
	})
}

func TestAddWritesGoldenLock(t *testing.T) {
	u := newUpstream(t, mitText, "v1")
	head := git(t, u.work, "rev-parse", "HEAD")
	root := t.TempDir()
	out, err := run(t, addCmd(u), "--root", root, "o/r#skills/x/SKILL.md")
	if err != nil {
		t.Fatal(err, out)
	}
	got, err := os.ReadFile(filepath.Join(root, LockFile))
	if err != nil {
		t.Fatal(err)
	}
	norm := []byte(strings.ReplaceAll(string(got), head, "<SHA>"))
	golden := filepath.Join("testdata", "add.lock.golden")
	if *update {
		if err := os.WriteFile(golden, norm, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if string(norm) != string(want) {
		t.Fatalf("lock differs from golden:\n%s", norm)
	}
	cached, err := os.ReadFile(filepath.Join(root, ".factory", "cache", "files", "o", "r", head, "skills/x/SKILL.md"))
	if err != nil || string(cached) != "v1" {
		t.Fatalf("cache file %q %v", cached, err)
	}
}

func TestAddAtRefResolvesToSha(t *testing.T) {
	u := newUpstream(t, mitText, "v1")
	first := git(t, u.work, "rev-parse", "HEAD")
	git(t, u.work, "tag", "v1.0")
	u.commit(t, mitText, "v2")
	git(t, u.work, "push", "--quiet", u.bare, "v1.0")
	for _, ref := range []string{"v1.0", first, first[:10]} {
		root := t.TempDir()
		if out, err := run(t, addCmd(u), "--root", root, "o/r#skills/x/SKILL.md@"+ref); err != nil {
			t.Fatal(ref, err, out)
		}
		l, err := ReadLock(filepath.Join(root, LockFile))
		if err != nil || len(l.Entries) != 1 || l.Entries[0].SHA != first || l.Entries[0].SHA256 != sum("v1") {
			t.Fatalf("ref %s: lock %+v %v", ref, l, err)
		}
	}
}

func TestAddRefusesLicences(t *testing.T) {
	for _, tc := range []struct{ name, text, want string }{
		{"agpl", agplText, "AGPL-3.0"},
		{"cc-by-sa", ccText, "CC-BY-SA-4.0"},
		{"none", "all rights reserved", "NOASSERTION"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := newUpstream(t, tc.text, "v1")
			root := t.TempDir()
			_, err := run(t, addCmd(u), "--root", root, "o/r#skills/x/SKILL.md")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err %v, want licence %s named", err, tc.want)
			}
			if _, err := os.Stat(filepath.Join(root, LockFile)); err == nil {
				t.Fatal("lock written for a refused licence")
			}
			if _, err := os.Stat(filepath.Join(root, ".factory", "cache", "files")); err == nil {
				t.Fatal("cache written for a refused licence")
			}
		})
	}
}

func TestAddTwiceLeavesLockByteIdentical(t *testing.T) {
	u := newUpstream(t, mitText, "v1")
	root := t.TempDir()
	for range 2 {
		if out, err := run(t, addCmd(u), "--root", root, "o/r#skills/x/SKILL.md"); err != nil {
			t.Fatal(err, out)
		}
		if _, err := run(t, addCmd(u), "--root", root, "o/r#skills/x/SKILL.md"); err != nil {
			t.Fatal(err)
		}
	}
	first, _ := os.ReadFile(filepath.Join(root, LockFile))
	// Upstream moves on; adding the same source again keeps the pinned sha.
	u.commit(t, mitText, "v2")
	if _, err := run(t, addCmd(u), "--root", root, "o/r#skills/x/SKILL.md"); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(filepath.Join(root, LockFile))
	if !bytes.Equal(first, second) {
		t.Fatalf("lock changed:\n%s\n%s", first, second)
	}
}

func TestAddKindAndArgs(t *testing.T) {
	u := newUpstream(t, mitText, "v1")
	for _, tc := range []struct {
		name string
		args []string
		kind Kind
		err  string
	}{
		{"inferred skill", []string{"o/r#skills/x/SKILL.md"}, KindSkill, ""},
		{"flag wins", []string{"--kind", "check", "o/r#skills/x/SKILL.md"}, KindCheck, ""},
		{"pinned form", []string{"o/r@" + git(t, u.work, "rev-parse", "HEAD") + "#skills/x/SKILL.md"}, KindSkill, ""},
		{"cannot infer", []string{"o/r#LICENSE"}, "", "cannot tell the kind"},
		{"bad kind", []string{"--kind", "nope", "o/r#skills/x/SKILL.md"}, "", "unknown kind"},
		{"no path", []string{"o/r"}, "", "want owner/repo"},
		{"missing file", []string{"o/r#skills/y/SKILL.md"}, "", "fetch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			_, err := run(t, addCmd(u), append([]string{"--root", root}, tc.args...)...)
			if tc.err != "" {
				if err == nil || !strings.Contains(err.Error(), tc.err) {
					t.Fatalf("err %v, want %q", err, tc.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			l, _ := ReadLock(filepath.Join(root, LockFile))
			if len(l.Entries) != 1 || l.Entries[0].Kind != tc.kind {
				t.Fatalf("lock %+v", l)
			}
		})
	}
}

func seeded(t *testing.T) (root, head string) {
	t.Helper()
	u := newUpstream(t, mitText, "v1")
	root = t.TempDir()
	if out, err := run(t, addCmd(u), "--root", root, "o/r#skills/x/SKILL.md"); err != nil {
		t.Fatal(err, out)
	}
	return root, git(t, u.work, "rev-parse", "HEAD")
}

func TestPacksListTextAndJSON(t *testing.T) {
	root, head := seeded(t)
	out, err := run(t, NewPacksCommand(), "list", "--root", root)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"x", "skill", "o/r@" + head + "#skills/x/SKILL.md", "MIT", sum("v1")[:12]} {
		if !strings.Contains(out, want) {
			t.Fatalf("list lacks %q:\n%s", want, out)
		}
	}
	out, err = run(t, NewPacksCommand(), "list", "--json", "--root", root)
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]string
	if err := json.Unmarshal([]byte(out), &rows); err != nil || len(rows) != 1 {
		t.Fatalf("json %q %v", out, err)
	}
	r := rows[0]
	if r["id"] != "x" || r["kind"] != "skill" || r["source"] != "o/r@"+head+"#skills/x/SKILL.md" || r["licence"] != "MIT" || r["hash"] != sum("v1")[:12] {
		t.Fatalf("row %v", r)
	}
}

func TestPacksListEmpty(t *testing.T) {
	out, err := run(t, NewPacksCommand(), "list", "--json", "--root", t.TempDir())
	if err != nil || strings.TrimSpace(out) != "[]" {
		t.Fatalf("%q %v", out, err)
	}
}

func TestPacksVerify(t *testing.T) {
	root, head := seeded(t)
	file := filepath.Join(root, ".factory", "cache", "files", "o", "r", head, "skills/x/SKILL.md")
	for _, tc := range []struct {
		name   string
		mutate func()
		want   string
	}{
		{"fresh", func() {}, ""},
		{"one byte changed", func() { _ = os.WriteFile(file, []byte("v2"), 0o644) }, "mismatch: skills/x/SKILL.md"},
		{"missing", func() { _ = os.Remove(file) }, "missing: skills/x/SKILL.md"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.mutate()
			out, err := run(t, NewPacksCommand(), "verify", "--root", root)
			if tc.want == "" {
				if err != nil {
					t.Fatal(err, out)
				}
				return
			}
			if err == nil || !strings.Contains(out, tc.want) {
				t.Fatalf("err %v out %q, want %q", err, out, tc.want)
			}
		})
	}
}
