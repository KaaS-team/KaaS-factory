package provenance

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRepoNoticesMatchHeaders is the gate: every ported Go file in this repo
// is listed in THIRD_PARTY_NOTICES.md.
func TestRepoNoticesMatchHeaders(t *testing.T) {
	problems, err := Check(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range problems {
		t.Error(p)
	}
}

func TestMissingNoticeIsReported(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "THIRD_PARTY_NOTICES.md", "# Third-party notices\n\n## owainlewis/machinist@3943516\n")
	write(t, dir, "a/listed.go", "// Ported from owainlewis/machinist@3943516 internal/runner/runner.go\npackage a\n")
	write(t, dir, "b/unlisted.go", "// Ported from mitkox/esf@abcdef1 cmd/esf/main.go\npackage b\n")
	write(t, dir, "vendor/x/skip.go", "// Ported from nobody/else@1234567 x.go\npackage x\n")

	problems, err := Check(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 1 {
		t.Fatalf("want exactly the esf file reported, got %q", problems)
	}
}

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestNoticeNamingMissingFileOrHeaderIsReported(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "THIRD_PARTY_NOTICES.md", "# Third-party notices\n\n## a/b@1234567\n\n"+
		"- `pkg/ok.go` from `x.go`\n"+
		"- `pkg/gone.go` from `y.go`\n"+
		"- `pkg/bare.go` from `z.go`\n"+
		"- `pkg/wrong.go` from `w.go`\n"+
		"- `docs/port.md` from `v.md`\n")
	write(t, dir, "pkg/ok.go", "// Ported from a/b@1234567 x.go\npackage pkg\n")
	write(t, dir, "pkg/bare.go", "package pkg\n")
	write(t, dir, "pkg/wrong.go", "// Ported from c/d@7654321 w.go\npackage pkg\n")
	write(t, dir, "docs/port.md", "text\n")

	problems, err := Check(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"pkg/gone.go": false, "pkg/bare.go": false, "pkg/wrong.go": false}
	for _, p := range problems {
		hit := false
		for f := range want {
			if strings.HasPrefix(p, f+":") {
				want[f], hit = true, true
			}
		}
		if !hit {
			t.Errorf("unexpected problem %q", p)
		}
	}
	for f, seen := range want {
		if !seen {
			t.Errorf("no problem reported for %s: %q", f, problems)
		}
	}
}
