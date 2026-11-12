package local

import (
	"os"
	"path"
	"path/filepath"
	"strings"
)

// writablePaths is every path a sandboxed agent may write: the temp dir, its own Claude config
// dir, and under gitDir only what a worktree commit needs. Hooks and config are never listed,
// so the host's next git command cannot run code the agent planted. Of refs and logs only the
// directory holding the session's branch is listed (refs/heads/factory for factory/7-a1), so main,
// other heads, tags and the lease refs stay out of reach. The jail's rules are directory paths, so
// the other branches under that same directory remain writable.
func writablePaths(gitDir, worktree, branch, cfgDir string) []string {
	rw := []string{os.TempDir(), os.DevNull}
	if cfgDir != "" {
		rw = append(rw, cfgDir)
	}
	if gitDir != "" {
		rw = append(rw, filepath.Join(gitDir, "objects"))
		if dir := path.Dir(branch); dir != "." && dir != "/" && !strings.Contains(dir, "..") {
			rw = append(rw, filepath.Join(gitDir, "refs", "heads", dir), filepath.Join(gitDir, "logs", "refs", "heads", dir))
		}
		rw = append(rw, filepath.Join(gitDir, "worktrees", filepath.Base(worktree)))
	}
	return rw
}

// newSessionDir makes a mode 0700 directory under the operator's cache dir. It is not under the
// temp dir because every jail may write there, so one agent could otherwise read or alter
// another session's copy of the login.
func newSessionDir() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	root := filepath.Join(cache, "factory", "sessions")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(root, "claude-")
	if err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	return dir, nil
}

// sessionConfigDir makes a private Claude config dir holding only the login file the CLI needs
// to start, copied from the operator's config. On macOS the login lives in the keychain, so the
// directory starts empty there. The operator's ~/.claude is never writable from the jail.
func sessionConfigDir() (string, error) {
	dir, err := newSessionDir()
	if err != nil {
		return "", err
	}
	src := os.Getenv("CLAUDE_CONFIG_DIR")
	if home, herr := os.UserHomeDir(); src == "" && herr == nil {
		src = filepath.Join(home, ".claude")
	}
	if b, err := os.ReadFile(filepath.Join(src, ".credentials.json")); err == nil {
		if err := writeLogin(filepath.Join(dir, ".credentials.json"), b); err != nil {
			_ = os.RemoveAll(dir)
			return "", err
		}
	}
	return dir, nil
}

// writeLogin is a variable so a test can fail the copy.
var writeLogin = func(path string, b []byte) error { return os.WriteFile(path, b, 0o600) }
