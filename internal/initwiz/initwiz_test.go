package initwiz

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/config"
)

// run executes the init command in dir with args, with stdin as the scripted input.
func run(t *testing.T, dir, stdin string, args ...string) (string, error) {
	t.Helper()
	c := NewCommand()
	var out bytes.Buffer
	c.SetOut(&out)
	c.SetErr(&out)
	c.SetIn(strings.NewReader(stdin))
	c.SetArgs(append([]string{"--dir", dir}, args...))
	err := c.Execute()
	return out.String(), err
}

func load(t *testing.T, dir string) config.Config {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, ".factory", "factory.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	l, err := config.Load(config.Sources{Repo: config.Source{Name: config.RepoFileYAML, Data: data}})
	if err != nil {
		t.Fatalf("written file does not load: %v\n%s", err, data)
	}
	return l.Config
}

// gitRepo makes a temp git repo; origin is set when non-empty.
func gitRepo(t *testing.T, origin string) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"remote", "add", "origin", origin}} {
		if args[0] == "remote" && origin == "" {
			continue
		}
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	return dir
}

// TestYesWritesPresetPerTier covers the --yes acceptance line: each tier loads with its preset values.
func TestYesWritesPresetPerTier(t *testing.T) {
	cases := []struct {
		tier       string
		slots      int
		dispatcher string
		approval   string
		mergeMode  string
		batch      int
		teamDay    float64
	}{
		{"solo", 1, "local", "always", "queue", 1, 100},
		{"startup", 3, "routines", "on-risk:low", "queue", 1, 100},
		{"scaleup", 6, "routines", "on-risk:low", "queue", 4, 100},
		{"enterprise", 6, "routines", "always", "queue", 1, 250},
		{"regulated", 3, "routines", "always", "queue", 1, 100},
		{"oss", 2, "local", "always", "queue", 1, 100},
	}
	for _, tc := range cases {
		t.Run(tc.tier, func(t *testing.T) {
			dir := gitRepo(t, "")
			if _, err := run(t, dir, "", "--yes", "--tier", tc.tier, "--tracker", "linear", "--repo", "acme/app"); err != nil {
				t.Fatal(err)
			}
			c := load(t, dir)
			if c.Slots != tc.slots || c.Dispatcher != tc.dispatcher || c.Approval != tc.approval ||
				c.MergeMode != tc.mergeMode || c.BatchSize != tc.batch || c.Budgets.TeamDay != tc.teamDay {
				t.Fatalf("preset mismatch: %+v", c)
			}
			if c.Tracker != "linear" || c.Repo != "acme/app" {
				t.Fatalf("answers lost: %+v", c)
			}
		})
	}
}

// TestRegulatedNeverAutoMerges pins the "approval required everywhere" preset.
func TestRegulatedNeverAutoMerges(t *testing.T) {
	dir := gitRepo(t, "")
	if _, err := run(t, dir, "", "--yes", "--tier", "regulated", "--tracker", "github"); err != nil {
		t.Fatal(err)
	}
	if c := load(t, dir); c.AutoMerge || !c.RequesterCannotApprove || c.Approval != "always" {
		t.Fatalf("%+v", c)
	}
}

// TestRejectsUnknownChoices checks every closed list refuses a stranger.
func TestRejectsUnknownChoices(t *testing.T) {
	for _, args := range [][]string{
		{"--yes", "--tier", "huge", "--tracker", "github"},
		{"--yes", "--tier", "solo", "--tracker", "trello"},
		{"--yes", "--tier", "solo", "--tracker", "github", "--dispatcher", "magic"},
		{"--yes", "--tracker", "github"},
		{"--yes", "--tier", "solo"},
	} {
		dir := gitRepo(t, "")
		if _, err := run(t, dir, "", args...); err == nil {
			t.Errorf("%v: want an error", args)
		}
		if _, err := os.Stat(filepath.Join(dir, ".factory")); err == nil {
			t.Errorf("%v: wrote something", args)
		}
	}
}

// TestNoOverwriteWithoutForce covers the overwrite acceptance line.
func TestNoOverwriteWithoutForce(t *testing.T) {
	dir := gitRepo(t, "")
	path := filepath.Join(dir, ".factory", "factory.yaml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("slots: 2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := run(t, dir, "", "--yes", "--tier", "solo", "--tracker", "github"); err == nil {
		t.Fatal("want a refusal")
	}
	if b, _ := os.ReadFile(path); string(b) != "slots: 2\n" {
		t.Fatalf("file changed: %q", b)
	}
	if _, err := run(t, dir, "", "--yes", "--force", "--tier", "solo", "--tracker", "github"); err != nil {
		t.Fatal(err)
	}
	if c := load(t, dir); c.Slots != 1 {
		t.Fatalf("force did not rewrite: %+v", c)
	}
}

// TestWritesOnlyFactoryYAML checks nothing else lands in the tree.
func TestWritesOnlyFactoryYAML(t *testing.T) {
	dir := t.TempDir()
	if _, err := run(t, dir, "", "--yes", "--tier", "solo", "--tracker", "github"); err != nil {
		t.Fatal(err)
	}
	var got []string
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, _ error) error {
		if !d.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			got = append(got, rel)
		}
		return nil
	})
	if len(got) != 1 || got[0] != filepath.Join(".factory", "factory.yaml") {
		t.Fatalf("files: %v", got)
	}
}

// TestRepoDefaultFromOrigin covers the origin-URL acceptance line, for each URL shape.
func TestRepoDefaultFromOrigin(t *testing.T) {
	for origin, want := range map[string]string{
		"https://github.com/acme/app.git": "acme/app",
		"https://github.com/acme/app":     "acme/app",
		"git@github.com:acme/app.git":     "acme/app",
		"ssh://git@github.com/acme/app":   "acme/app",
	} {
		t.Run(origin, func(t *testing.T) {
			dir := gitRepo(t, origin)
			if _, err := run(t, dir, "", "--yes", "--tier", "solo", "--tracker", "github"); err != nil {
				t.Fatal(err)
			}
			if c := load(t, dir); c.Repo != want {
				t.Fatalf("repo %q, want %q", c.Repo, want)
			}
		})
	}
}

// TestNoOriginLeavesRepoUnset checks a repo without a remote still gets a loadable file.
func TestNoOriginLeavesRepoUnset(t *testing.T) {
	dir := gitRepo(t, "")
	if _, err := run(t, dir, "", "--yes", "--tier", "solo", "--tracker", "github"); err != nil {
		t.Fatal(err)
	}
	if c := load(t, dir); c.Repo != "" {
		t.Fatalf("repo %q", c.Repo)
	}
}

// TestFormMatchesYes covers the interactive acceptance line: scripted accessible input writes the
// same bytes as --yes for the same answers. Accessible select prompts take a 1-based number; an
// input prompt takes the text, or an empty line to keep the default.
func TestFormMatchesYes(t *testing.T) {
	for _, tier := range []string{"solo", "startup", "scaleup", "enterprise", "regulated", "oss"} {
		t.Run(tier, func(t *testing.T) {
			want := gitRepo(t, "https://github.com/acme/app.git")
			if _, err := run(t, want, "", "--yes", "--tier", tier, "--tracker", "jira", "--dispatcher", "fire"); err != nil {
				t.Fatal(err)
			}
			tierNo := indexOf(Tiers(), tier) + 1
			got := gitRepo(t, "https://github.com/acme/app.git")
			in := strings.Join([]string{itoa(tierNo), "3", "", itoa(indexOf(Dispatchers(), "fire") + 1)}, "\n") + "\n"
			if out, err := run(t, got, in, "--accessible"); err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			a, _ := os.ReadFile(filepath.Join(want, ".factory", "factory.yaml"))
			b, _ := os.ReadFile(filepath.Join(got, ".factory", "factory.yaml"))
			if len(a) == 0 || !bytes.Equal(a, b) {
				t.Fatalf("form wrote\n%s\nyes wrote\n%s", b, a)
			}
		})
	}
}

func indexOf(l []string, s string) int {
	for i, v := range l {
		if v == s {
			return i
		}
	}
	return -1
}

func itoa(n int) string { return string(rune('0' + n)) }
