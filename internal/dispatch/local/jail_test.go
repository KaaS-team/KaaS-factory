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
		{"git and config", git, cfg, []string{os.TempDir(), os.DevNull, cfg, git + "/objects", git + "/refs/heads/factory", git + "/logs/refs/heads/factory", git + "/worktrees/wt-1"}},
	}
	for _, r := range rows {
		got := writablePaths(r.gitDir, "/w/wt-1", "factory/7-a1", r.cfgDir)
		if !slices.Equal(got, r.want) {
			t.Errorf("%s: got %v, want %v", r.name, got, r.want)
		}
		for _, p := range got {
			if p == git || p == git+"/refs" || p == git+"/refs/heads" || p == git+"/logs" || strings.Contains(p, "hooks") || strings.HasSuffix(p, "config") ||
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
	run(repo, "worktree", "add", "-q", "-B", bf.Branch, wt, "main")
	run(repo, "tag", "v1")
	if err := os.MkdirAll(filepath.Join(repo, ".git", "refs", "factory", "lease"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".git", "refs", "factory", "lease", "7"), []byte("0000000000000000000000000000000000000000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	g := filepath.Join(repo, ".git")
	body := "echo x > '" + g + "/hooks/post-checkout' 2>hook.err; echo $? > hook.rc\n" +
		"echo '[core]' >> '" + g + "/config' 2>cfg.err; echo $? > cfg.rc\n" +
		"echo ok > mine.txt; echo $? > own.rc\n" +
		"for r in refs/heads/main refs/tags/v1 refs/factory/lease/7 refs/heads/other; do echo $(git rev-parse HEAD) > '" + g + "/'$r 2>/dev/null; echo $r=$? >> refs.rc; done\n" +
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
	for _, line := range strings.Fields(read(t, filepath.Join(wt, "refs.rc"))) {
		if strings.HasSuffix(line, "=0") {
			t.Errorf("agent moved a ref outside its branch directory: %s", line)
		}
	}
	if rc("own.rc") != "0" || rc("commit.rc") != "0" {
		t.Errorf("worktree write rc %s, commit rc %s: %s", rc("own.rc"), rc("commit.rc"), read(t, filepath.Join(wt, "commit.err")))
	}
}

// sessionRoot points the per-session config dirs at an empty directory the test can list.
func sessionRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", root)
	t.Setenv("HOME", root)
	return filepath.Join(root, "factory", "sessions")
}

func entries(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	return names
}

// The session config dir holds a copy of the operator's login, so it must be gone when the
// session ends, be mode 0700, and sit outside the temp dir every jail may write.
func TestSessionConfigDirIsRemovedWhenTheSessionEnds(t *testing.T) {
	skipWithoutJail(t)
	root := sessionRoot(t)
	t.Setenv("TMPDIR", t.TempDir()) // the jail's temp dir, apart from the cache root above
	op := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", op)
	if err := os.WriteFile(filepath.Join(op, ".credentials.json"), []byte("login"), 0o600); err != nil {
		t.Fatal(err)
	}
	d, wt := sandboxed(t, "echo $CLAUDE_CONFIG_DIR > cfg.txt\n{ stat -c %a $CLAUDE_CONFIG_DIR 2>/dev/null || stat -f %Lp $CLAUDE_CONFIG_DIR; } > mode.txt\ncat $CLAUDE_CONFIG_DIR/.credentials.json > cred.txt\n", []string{"PATH=" + os.Getenv("PATH")})
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	wait(t, d, s)
	dir := strings.TrimSpace(read(t, filepath.Join(wt, "cfg.txt")))
	if got := read(t, filepath.Join(wt, "cred.txt")); strings.TrimSpace(got) != "login" {
		t.Fatalf("the agent saw credentials %q, want the operator's login", got)
	}
	if m := strings.TrimSpace(read(t, filepath.Join(wt, "mode.txt"))); m != "700" {
		t.Errorf("session dir mode %s, want 700", m)
	}
	if strings.HasPrefix(dir, os.TempDir()+string(filepath.Separator)) {
		t.Errorf("session dir %s is under the temp dir, which every jail can write", dir)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("session dir %s still exists after the run (err %v)", dir, err)
	}
	if left := entries(t, root); len(left) != 0 {
		t.Errorf("session root still holds %v", left)
	}
}

// A start that fails after the dir was made, here because the agent binary is missing, removes it.
func TestSessionConfigDirIsRemovedWhenStartFails(t *testing.T) {
	skipWithoutJail(t)
	root := sessionRoot(t)
	op := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", op)
	if err := os.WriteFile(filepath.Join(op, ".credentials.json"), []byte("login"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d, err := New(ctx, Config{Worktrees: dirWorktrees{t.TempDir()}, Binary: "/nonexistent/agent", Sandbox: true,
		Environ: []string{"PATH=" + os.Getenv("PATH")}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Dispatch(ctx, bf); err == nil {
		t.Fatal("dispatch of a missing binary succeeded")
	}
	if left := entries(t, root); len(left) != 0 {
		t.Errorf("session root still holds %v after a failed start", left)
	}
}

// A copy that fails half way leaves nothing behind.
func TestSessionConfigDirIsRemovedWhenTheLoginCopyFails(t *testing.T) {
	root := sessionRoot(t)
	op := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", op)
	if err := os.WriteFile(filepath.Join(op, ".credentials.json"), []byte("login"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	prev := writeLogin
	writeLogin = func(string, []byte) error { return os.ErrPermission }
	t.Cleanup(func() { writeLogin = prev })
	if _, err := sessionConfigDir(); err == nil {
		t.Fatal("copy failure was swallowed")
	}
	if left := entries(t, root); len(left) != 0 {
		t.Errorf("failed copy left %v", left)
	}
}

// A branch with no directory part, or one that climbs out of refs/heads, gets no refs entry: the
// only grant that would let git create it is refs/heads itself.
func TestWritablePathsGrantNoRefsForABranchWithoutADirectory(t *testing.T) {
	for _, b := range []string{"main", "", "../../hooks/x"} {
		for _, p := range writablePaths("/repo/.git", "/w/wt-1", b, "") {
			if strings.Contains(p, "refs") || strings.Contains(p, "hooks") {
				t.Errorf("branch %q: %s must not be writable", b, p)
			}
		}
	}
}
