package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func put(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// Acceptance: did-you-mean suggestions on schema errors.
func TestDidYouMean(t *testing.T) {
	cases := []struct {
		name, fm, want string
	}{
		{"top key typo", "on: manual\nsafe_output: [pr]", `did you mean "safe_outputs"`},
		{"top key far", "on: manual\nzzzzzzzz: 1", `unknown key "zzzzzzzz"`},
		{"step key typo", "on: manual\nnodes:\n  a: { uses: build, labl: x }", `did you mean "label"`},
		{"step type typo", "on: manual\nnodes:\n  a: { uses: bild }", `did you mean "build"`},
	}
	for _, c := range cases {
		_, err := LoadMarkdown(put(t, t.TempDir(), "w.md", "---\n"+c.fm+"\n---\nbody\n"))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want %q", c.name, err, c.want)
		}
		if c.name == "top key far" && err != nil && strings.Contains(err.Error(), "did you mean") {
			t.Errorf("far key got a suggestion: %v", err)
		}
	}
}

func TestEditDistance(t *testing.T) {
	cases := []struct {
		a, b string
		n    int
	}{{"", "", 0}, {"a", "", 1}, {"", "ab", 2}, {"kitten", "sitting", 3}, {"same", "same", 0}}
	for _, c := range cases {
		if got := editDistance(c.a, c.b); got != c.n {
			t.Errorf("%q %q: %d want %d", c.a, c.b, got, c.n)
		}
	}
}

// Acceptance: imports expand in topological order.
func TestImportsTopologicalOrder(t *testing.T) {
	d := t.TempDir()
	put(t, d, "a.md", "---\nimports: [b.md, c.md]\n---\nA\n")
	put(t, d, "b.md", "---\nimports: [c.md]\nsafe_outputs: [label]\n---\nB\n")
	put(t, d, "c.md", "C\n")
	p := put(t, d, "w.md", "---\non: manual\nimports: [a.md]\nsafe_outputs: [comment]\n---\nMAIN\n")
	g, err := LoadMarkdown(p)
	if err != nil {
		t.Fatal(err)
	}
	if g.Prompt != "C\n\nB\n\nA\n\nMAIN" {
		t.Errorf("prompt %q", g.Prompt)
	}
	want := []WriteKind{WriteComment, WriteLabel}
	if len(g.SafeOutputs) != 2 || g.SafeOutputs[0] != want[0] || g.SafeOutputs[1] != want[1] {
		t.Errorf("safe outputs %v", g.SafeOutputs)
	}
}

// Acceptance: cycles are reported as a full path.
func TestImportCyclePath(t *testing.T) {
	d := t.TempDir()
	put(t, d, "a.md", "---\nimports: [b.md]\n---\nA\n")
	put(t, d, "b.md", "---\nimports: [c.md]\n---\nB\n")
	put(t, d, "c.md", "---\nimports: [a.md]\n---\nC\n")
	p := put(t, d, "w.md", "---\nimports: [a.md]\n---\nM\n")
	_, err := LoadMarkdown(p)
	if err == nil || !strings.Contains(err.Error(), "a.md -> b.md -> c.md -> a.md") {
		t.Errorf("got %v", err)
	}
}

func TestImportRefusals(t *testing.T) {
	d := t.TempDir()
	put(t, d, "bad.md", "---\non: manual\n---\nB\n")
	put(t, d, "self.md", "---\nimports: [self.md]\n---\nS\n")
	cases := map[string]string{
		"missing":        "imports: [nope.md]",
		"outside root":   "imports: [../x.md]",
		"absolute":       "imports: [/etc/passwd]",
		"not a list":     "imports: a.md",
		"import own key": "imports: [bad.md]",
		"self cycle":     "imports: [self.md]",
	}
	for name, fm := range cases {
		_, err := LoadMarkdown(put(t, d, "sub/w.md", "---\n"+fm+"\n---\nM\n"))
		if name == "outside root" || name == "absolute" {
			if err == nil || !strings.Contains(err.Error(), "import") {
				t.Errorf("%s: %v", name, err)
			}
			continue
		}
		if err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// Acceptance: canonical sorted-key hash.
func TestCanonicalHash(t *testing.T) {
	d := t.TempDir()
	a, err := LoadMarkdown(put(t, d, "a.md", "---\non: manual\nagent: claude\nbudget: 2\n---\nbody\n"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadMarkdown(put(t, d, "b.md", "---\nbudget: 2\nagent: claude\non: manual\n---\nbody\n"))
	if err != nil {
		t.Fatal(err)
	}
	c, _ := LoadMarkdown(put(t, d, "c.md", "---\nbudget: 3\nagent: claude\non: manual\n---\nbody\n"))
	e, _ := LoadMarkdown(put(t, d, "e.md", "---\nbudget: 2\nagent: claude\non: manual\n---\nother\n"))
	if len(a.Hash) != 64 || a.Hash != b.Hash {
		t.Errorf("key order changed the hash: %q %q", a.Hash, b.Hash)
	}
	if a.Hash == c.Hash || a.Hash == e.Hash {
		t.Error("a content change kept the hash")
	}
	y, err := ParseYAML("w", []byte("steps:\n  triage: { uses: triage }\n"))
	if err != nil || len(y.Hash) != 64 {
		t.Errorf("yaml hash %q %v", y.Hash, err)
	}
	if h := CanonicalHash(map[string]any{"b": 1, "a": []any{map[string]any{"z": 1, "y": 2}}}, "x"); h !=
		CanonicalHash(map[string]any{"a": []any{map[string]any{"y": 2, "z": 1}}, "b": 1}, "x") {
		t.Error("nested order changed the hash")
	}
}

// Acceptance: a graph that asks for a write credential on an agent node is refused at load.
func TestWriteCredentialRefused(t *testing.T) {
	cases := []struct {
		name, fm string
		bad      bool
	}{
		{"top level write", "credentials: [github:write]", true},
		{"agent node write", "nodes:\n  a: { uses: build, credentials: [tracker:write] }", true},
		{"token name", "credentials: [GITHUB_TOKEN]", true},
		{"read only", "credentials: [github:read]", false},
		{"check node write", "nodes:\n  a: { uses: build, next: c }\n  c: { uses: check, run: make, credentials: [github:write] }", false},
		{"none", "on: manual", false},
	}
	for _, c := range cases {
		_, err := LoadMarkdown(put(t, t.TempDir(), "w.md", "---\n"+c.fm+"\n---\nbody\n"))
		if c.bad != (err != nil && strings.Contains(err.Error(), "write credential")) {
			t.Errorf("%s: bad=%v err=%v", c.name, c.bad, err)
		}
		if !c.bad && err != nil {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}

// A symlinked import may not reach a file outside the workflow directory; one inside is fine.
func TestImportSymlinkEscapeRefused(t *testing.T) {
	outer, d := t.TempDir(), t.TempDir()
	secret := put(t, outer, "secret.md", "OUTSIDE\n")
	put(t, d, "real.md", "INSIDE\n")
	if err := os.Symlink(secret, filepath.Join(d, "escape.md")); err != nil {
		t.Skip(err)
	}
	if err := os.Symlink("real.md", filepath.Join(d, "ok.md")); err != nil {
		t.Skip(err)
	}
	if err := os.Symlink(outer, filepath.Join(d, "dir")); err != nil {
		t.Skip(err)
	}
	for _, imp := range []string{"escape.md", "dir/secret.md"} {
		_, err := LoadMarkdown(put(t, d, "w.md", "---\nimports: ["+imp+"]\n---\nM\n"))
		if err == nil || !strings.Contains(err.Error(), "import") {
			t.Errorf("%s: got %v, want a refusal", imp, err)
		}
	}
	g, err := LoadMarkdown(put(t, d, "w.md", "---\nimports: [ok.md]\n---\nM\n"))
	if err != nil || !strings.Contains(g.Prompt, "INSIDE") {
		t.Errorf("inside symlink: %v %v", g, err)
	}
}

// Every name the list claims to refuse, and the near misses it must not.
func TestWriteCredentialNames(t *testing.T) {
	bad := []string{"github:write", "tracker:write", "GITHUB_TOKEN", "gh_token", "API_SECRET", "AWS_SECRET_ACCESS_KEY",
		"DEPLOY_KEY", "OPENAI_API_KEY", "APIKEY", "DB_PASSWORD", "db_passwd", "DB_PWD", "GH_PAT", "PAT", "github-pat",
		"MY_PASS", "PRIVATE_KEY", "PRIVATEKEY", "SERVICE_CREDENTIALS", "BASIC_AUTH"}
	good := []string{"github:read", "tracker:read", "PATH", "PATTERN", "PASSIVE", "AUTHOR", "KEYBOARD", "REPO", "none"}
	for _, n := range bad {
		if !writeCredential(n) {
			t.Errorf("%q accepted", n)
		}
		if err := checkNoWriteCredential("w", []string{n}); err == nil {
			t.Errorf("%q not refused", n)
		}
	}
	for _, n := range good {
		if writeCredential(n) {
			t.Errorf("%q refused", n)
		}
	}
}
