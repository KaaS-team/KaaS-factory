package local

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// A session on a PR from an author without write access gets the deny list and has the files the
// agent CLI trusts put back after it ends; a session on a trusted PR is left alone.
func TestUntrustedSessionIsGuarded(t *testing.T) {
	for _, tc := range []struct {
		name    string
		deny    []string
		wantCfg string
	}{
		{"untrusted author", []string{"Bash(npm:*)"}, `{"safe":true}`},
		{"trusted author", nil, `{"planted":true}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wt := t.TempDir()
			if err := os.MkdirAll(filepath.Join(wt, ".claude"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(wt, ".claude/settings.json"), []byte(`{"safe":true}`), 0o644); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			body := "echo '{\"planted\":true}' > .claude/settings.json\nprintf '%s\\n' \"$@\" > argv.txt\n"
			d, err := New(ctx, Config{
				Worktrees: dirWorktrees{wt}, Binary: script(t, body), Environ: []string{"PATH=" + os.Getenv("PATH")}, Now: time.Now,
				Untrusted: func(context.Context, api.Brief) []string { return tc.deny },
			})
			if err != nil {
				t.Fatal(err)
			}
			s, err := d.Dispatch(context.Background(), bf)
			if err != nil {
				t.Fatal(err)
			}
			wait(t, d, s)
			if got := strings.TrimSpace(read(t, filepath.Join(wt, ".claude/settings.json"))); got != tc.wantCfg {
				t.Errorf("settings.json = %s, want %s", got, tc.wantCfg)
			}
			if got := strings.Contains(read(t, filepath.Join(wt, "argv.txt")), "Bash(npm:*)"); got != (tc.deny != nil) {
				t.Errorf("deny list in argv = %v", got)
			}
		})
	}
}

// The untrusted run's argv allows only the allowlisted shell commands; find, which the stage
// allows for a trusted run, runs code with -exec and must not be among them.
func TestUntrustedArgvAllowsOnlyAllowlistedBash(t *testing.T) {
	for _, tc := range []struct {
		name     string
		deny     []string
		wantFind bool
	}{{"untrusted", []string{"Bash(npm:*)"}, false}, {"trusted", nil, true}} {
		t.Run(tc.name, func(t *testing.T) {
			wt := t.TempDir()
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			d, err := New(ctx, Config{
				Worktrees: dirWorktrees{wt}, Binary: script(t, "printf '%s\\n' \"$@\" > argv.txt\n"),
				Environ: []string{"PATH=" + os.Getenv("PATH")}, Now: time.Now,
				Untrusted: func(context.Context, api.Brief) []string { return tc.deny },
			})
			if err != nil {
				t.Fatal(err)
			}
			s, err := d.Dispatch(context.Background(), bf)
			if err != nil {
				t.Fatal(err)
			}
			wait(t, d, s)
			argv := read(t, filepath.Join(wt, "argv.txt"))
			if got := strings.Contains(argv, "Bash(find *)"); got != tc.wantFind {
				t.Errorf("Bash(find *) in argv = %v, want %v", got, tc.wantFind)
			}
			if !strings.Contains(argv, "Bash(git status *)") {
				t.Error("git status was cut from the allow list")
			}
		})
	}
}

// The agent CLI re-reads its settings while it runs, so a planted file is put back mid-run, not
// only when the process exits.
func TestUntrustedSettingsRestoredMidRun(t *testing.T) {
	wt := t.TempDir()
	if err := os.MkdirAll(filepath.Join(wt, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wt, ".claude/settings.json"), []byte(`{"safe":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	body := `echo '{"planted":true}' > .claude/settings.json
echo '{"type":"assistant"}'
for i in $(seq 1 60); do
  if grep -q safe .claude/settings.json; then echo restored > mid.txt; break; fi
  sleep 0.1
done
`
	d, err := New(ctx, Config{
		Worktrees: dirWorktrees{wt}, Binary: script(t, body), Environ: []string{"PATH=" + os.Getenv("PATH")}, Now: time.Now,
		Untrusted: func(context.Context, api.Brief) []string { return []string{"Bash(npm:*)"} },
	})
	if err != nil {
		t.Fatal(err)
	}
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	wait(t, d, s)
	if got := strings.TrimSpace(read(t, filepath.Join(wt, "mid.txt"))); got != "restored" {
		t.Errorf("settings.json was not restored while the run was going (mid.txt = %q)", got)
	}
}
