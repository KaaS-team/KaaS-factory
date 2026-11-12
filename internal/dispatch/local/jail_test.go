package local

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/pkg/sandbox"
)

// skipWithoutJail skips with the probe's reason where Landlock is absent (CI hosts).
func skipWithoutJail(t *testing.T) {
	t.Helper()
	if c := sandbox.Probe(); !c.Landlock && !c.SandboxExec {
		t.Skipf("no jail on this host: %+v", c)
	}
}

// Symphony spec 15.2 (workspace safety): the writable list holds no hooks, no config, and not
// the operator's ~/.claude, whatever the session.
func TestWritablePathsNeverIncludeHooksConfigOrOperatorClaude(t *testing.T) {
	home, _ := os.UserHomeDir()
	git := "/repo/.git"
	cfg := "/tmp/factory-claude-x"
	rows := []struct {
		name, gitDir, cfgDir string
		want                 []string
	}{
		{"no git, no config", "", "", []string{os.TempDir(), os.DevNull}},
		{"config dir only", "", cfg, []string{os.TempDir(), os.DevNull, cfg}},
		{"git and config", git, cfg, []string{os.TempDir(), os.DevNull, cfg, git + "/objects", git + "/refs", git + "/logs", git + "/worktrees/wt-1"}},
	}
	for _, r := range rows {
		got := writablePaths(r.gitDir, "/w/wt-1", r.cfgDir)
		if !slices.Equal(got, r.want) {
			t.Errorf("%s: got %v, want %v", r.name, got, r.want)
		}
		for _, p := range got {
			if p == git || strings.Contains(p, "hooks") || strings.HasSuffix(p, "config") ||
				p == filepath.Join(home, ".claude") || p == filepath.Join(home, ".claude.json") {
				t.Errorf("%s: %s must not be writable", r.name, p)
			}
		}
	}
}

func TestSessionConfigDirIsPrivateAndCarriesOnlyTheLogin(t *testing.T) {
	op := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", op)
	for n, c := range map[string]string{".credentials.json": "login", "settings.json": "{}"} {
		if err := os.WriteFile(filepath.Join(op, n), []byte(c), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	dir, err := sessionConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if dir == op {
		t.Fatal("session dir is the operator's")
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 || ents[0].Name() != ".credentials.json" {
		t.Fatalf("session dir holds %v, want only the login", ents)
	}
}

// Dispatch with the jail on points the agent at a session config dir and lists it as writable.
func TestSandboxDispatchUsesSessionConfigDir(t *testing.T) {
	skipWithoutJail(t)
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	d, wt := sandboxed(t, "echo $CLAUDE_CONFIG_DIR > cfg.txt\n", []string{"PATH=" + os.Getenv("PATH")})
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	wait(t, d, s)
	got := strings.TrimSpace(read(t, filepath.Join(wt, "cfg.txt")))
	home, _ := os.UserHomeDir()
	if got == "" || got == filepath.Join(home, ".claude") || got == os.Getenv("CLAUDE_CONFIG_DIR") {
		t.Fatalf("CLAUDE_CONFIG_DIR = %q", got)
	}
}

// A jailed agent cannot plant a hook or edit git config; it can write its worktree and commit.
func TestSandboxBlocksGitHooksAndConfigButNotTheWorktree(t *testing.T) {
	skipWithoutJail(t)
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	// The jail's temp dir must not contain the repo, so the repo lives under the package dir.
	t.Setenv("TMPDIR", t.TempDir())
	repo, err := os.MkdirTemp(".", "jailrepo-")
	if err != nil {
		t.Fatal(err)
	}
	repo, _ = filepath.Abs(repo)
	t.Cleanup(func() { _ = os.RemoveAll(repo) })
	run := func(dir string, args ...string) {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@e.test", "-c", "commit.gpgsign=false"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run(repo, "init", "-q", "-b", "main")
	run(repo, "commit", "-q", "--allow-empty", "-m", "i")
	if err := os.MkdirAll(filepath.Join(repo, ".git", "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	wt := filepath.Join(repo, "wt")
	run(repo, "worktree", "add", "-q", "-B", "b", wt, "main")
	g := filepath.Join(repo, ".git")
	body := "echo x > .git/hooks/post-checkout 2>hook.err; echo $? > hook.rc\n" +
		"echo '[core]' >> '" + g + "/config' 2>cfg.err; echo $? > cfg.rc\n" +
		"echo ok > mine.txt; echo $? > own.rc\n" +
		"git -c user.name=t -c user.email=t@e.test add mine.txt 2>commit.err && git -c user.name=t -c user.email=t@e.test -c commit.gpgsign=false commit -q -m m 2>commit.err; echo $? > commit.rc\n"
	script := script(t, body)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d, err := New(ctx, Config{Worktrees: dirWorktrees{wt}, Binary: script, Sandbox: true, GitDir: g,
		Environ: []string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir()}})
	if err != nil {
		t.Fatal(err)
	}
	s, err := d.Dispatch(ctx, bf)
	if err != nil {
		t.Fatal(err)
	}
	wait(t, d, s)
	rc := func(n string) string { return strings.TrimSpace(read(t, filepath.Join(wt, n))) }
	if rc("hook.rc") == "0" || rc("cfg.rc") == "0" {
		t.Errorf("agent wrote hooks (rc %s) or config (rc %s)", rc("hook.rc"), rc("cfg.rc"))
	}
	if _, err := os.Stat(filepath.Join(g, "hooks", "post-checkout")); err == nil {
		t.Error("hook exists")
	}
	if rc("own.rc") != "0" || rc("commit.rc") != "0" {
		t.Errorf("worktree write rc %s, commit rc %s: %s", rc("own.rc"), rc("commit.rc"), read(t, filepath.Join(wt, "commit.err")))
	}
}
