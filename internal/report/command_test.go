package report

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := NewCommand(
		WithSource(func(context.Context) (Source, error) { return &fakeSource{recs: fixture()}, nil }),
		WithNow(func() time.Time { return at(24 * 10) }),
	)
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs(args)
	err := cmd.ExecuteContext(context.Background())
	return out.String(), err
}

func TestCommandWindowAndFormat(t *testing.T) {
	out, err := run(t, "--since", "7d", "--by", "workflow")
	if err != nil {
		t.Fatal(err)
	}
	// now is hour 240, so 7d starts at hour 72: no fixture ticket merged after that.
	if !strings.Contains(out, "| workflow |") || !strings.Contains(out, "| all | 0 |") {
		t.Fatalf("out = %s", out)
	}
	out, err = run(t, "--since", "30d", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"by": "team"`) || !strings.Contains(out, `"total": {
    "key": "all",
    "merged_prs": 4,`) {
		t.Fatalf("out = %s", out)
	}
}

func TestCommandBadFlags(t *testing.T) {
	for _, args := range [][]string{{"--by", "nope"}, {"--since", "soon"}, {"--since", "0d"}, {"--since", "-3d"}} {
		if _, err := run(t, args...); err == nil {
			t.Errorf("%v: want error", args)
		}
	}
}

func TestCommandNeedsSource(t *testing.T) {
	cmd := NewCommand()
	cmd.SetArgs(nil)
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	if err := cmd.Execute(); err == nil {
		t.Fatal("want error without a source")
	}
}

func TestCommandOutRefusals(t *testing.T) {
	dir := t.TempDir()
	for _, p := range []string{
		filepath.Join(dir, ".github", "report.md"),
		filepath.Join(dir, ".GitHub", "workflows", "r.md"),
		filepath.Join(dir, "a", "..", ".github", "r.md"),
		filepath.Join(dir, "pr-body.md"),
		filepath.Join(dir, "PR_BODY.md"),
		filepath.Join(dir, "pull_request_template.md"),
	} {
		t.Run(filepath.Base(p), func(t *testing.T) {
			if _, err := run(t, "--out", p); err == nil || !strings.Contains(err.Error(), "operator") {
				t.Fatalf("err = %v", err)
			}
			if _, err := os.Stat(p); err == nil {
				t.Fatal("file was written")
			}
		})
	}
	// a symlinked directory that points under .github is refused too
	gh := filepath.Join(dir, ".github")
	if err := os.Mkdir(gh, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "out")
	if err := os.Symlink(gh, link); err != nil {
		t.Fatal(err)
	}
	if _, err := run(t, "--out", filepath.Join(link, "r.md")); err == nil {
		t.Fatal("symlink into .github must be refused")
	}
}

func TestCommandOutWrites(t *testing.T) {
	p := filepath.Join(t.TempDir(), "report.md")
	if _, err := run(t, "--out", p); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil || !strings.Contains(string(b), "# Factory unit economics") {
		t.Fatalf("file = %q, %v", b, err)
	}
}
