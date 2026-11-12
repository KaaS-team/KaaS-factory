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
