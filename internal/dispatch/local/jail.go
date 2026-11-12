package local

import (
	"os"
	"path/filepath"
)

// writablePaths is every path a sandboxed agent may write: the temp dir, its own Claude config
// dir, and under gitDir only what a worktree commit needs. Hooks and config are never listed,
// so the host's next git command cannot run code the agent planted.
func writablePaths(gitDir, worktree, cfgDir string) []string {
	rw := []string{os.TempDir(), os.DevNull}
	if cfgDir != "" {
		rw = append(rw, cfgDir)
	}
	if gitDir != "" {
		rw = append(rw, filepath.Join(gitDir, "objects"), filepath.Join(gitDir, "refs"), filepath.Join(gitDir, "logs"),
			filepath.Join(gitDir, "worktrees", filepath.Base(worktree)))
	}
	return rw
}

// sessionConfigDir makes a private Claude config dir holding only the login file the CLI needs
// to start, copied from the operator's config. On macOS the login lives in the keychain, so the
// directory starts empty there. The operator's ~/.claude is never writable from the jail.
func sessionConfigDir() (string, error) {
	dir, err := os.MkdirTemp("", "factory-claude-")
	if err != nil {
		return "", err
	}
	src := os.Getenv("CLAUDE_CONFIG_DIR")
	if home, herr := os.UserHomeDir(); src == "" && herr == nil {
		src = filepath.Join(home, ".claude")
	}
	if b, err := os.ReadFile(filepath.Join(src, ".credentials.json")); err == nil {
		if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), b, 0o600); err != nil {
			return "", err
		}
	}
	return dir, nil
}
