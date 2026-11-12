package local

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/dispatch/brief"
)

// Worktrees prepares the directory a run executes in.
type Worktrees interface {
	Add(ctx context.Context, b api.Brief) (dir string, err error)
}

// GitWorktrees creates one git worktree per session under Root, on the
// brief's branch, starting from origin/<base> of the repo at Repo.
type GitWorktrees struct {
	Repo string
	Root string
}

// Add returns <Root>/factory-<ticket>-a<attempt>, creating it when absent so
// a retried dispatch finds the same worktree.
func (g GitWorktrees) Add(ctx context.Context, b api.Brief) (string, error) {
	if _, err := brief.Render(b); err != nil { // refs and ticket are checked there
		return "", err
	}
	dir := filepath.Join(g.Root, fmt.Sprintf("factory-%s-a%d", b.Ticket, b.Attempt))
	if _, err := os.Stat(dir); err == nil {
		return dir, nil
	}
	if err := os.MkdirAll(g.Root, 0o755); err != nil {
		return "", err
	}
	cmd := exec.CommandContext(ctx, "git", "-C", g.Repo, "worktree", "add", "-B", b.Branch, dir, "origin/"+b.Base)
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("local: git worktree add: %w: %s", err, firstLine(out))
	}
	return dir, nil
}

func firstLine(b []byte) string {
	for i, c := range b {
		if c == '\n' {
			return string(b[:i])
		}
	}
	return string(b)
}
