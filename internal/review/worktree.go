// Ported from continuedev/continue@5522c6f extensions/cli/src/commands/review/worktree.ts
package review

import (
	"bytes"
	"context"
	"fmt"
	"github.com/KaaS-team/factory/internal/gitx"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// git runs git in dir with argv (no shell) and returns stdout. stdin may be nil.
func git(ctx context.Context, dir string, stdin []byte, args ...string) (string, error) {
	base := []string{"-C", dir, "-c", "user.name=factory", "-c", "user.email=factory@localhost", "-c", "commit.gpgsign=false"}
	cmd := exec.CommandContext(ctx, "git", append(base, args...)...)
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("review: git %s: %w: %s", args[0], err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

func stageAll(ctx context.Context, dir string) error {
	return gitx.StageAll(ctx, func(ctx context.Context, args ...string) (string, error) { return git(ctx, dir, nil, args...) })
}

// worktree is a disposable checkout of repo at HEAD with the repo's uncommitted state committed on top.
type worktree struct {
	repo, dir string
}

// addWorktree creates a detached worktree at HEAD, applies staged and unstaged changes, copies
// untracked files, and commits that state so a later diff holds only what the agent changed.
// On any error it removes what it made.
func addWorktree(ctx context.Context, repo string) (w *worktree, err error) {
	dir, err := os.MkdirTemp("", "factory-review-")
	if err != nil {
		return nil, err
	}
	w = &worktree{repo: repo, dir: dir}
	defer func() {
		if err != nil {
			w.remove()
			w = nil
		}
	}()
	if _, err = git(ctx, repo, nil, "worktree", "add", "--detach", dir, "HEAD"); err != nil {
		return nil, err
	}
	diff, err := git(ctx, repo, nil, "diff", "HEAD", "--binary")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(diff) != "" {
		if _, err = git(ctx, dir, []byte(diff), "apply", "--allow-empty", "-"); err != nil {
			return nil, err
		}
	}
	untracked, err := git(ctx, repo, nil, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	for _, f := range strings.Split(untracked, "\x00") {
		if f == "" {
			continue
		}
		if err = copyFile(filepath.Join(repo, f), filepath.Join(dir, f)); err != nil {
			return nil, err
		}
	}
	if err = stageAll(ctx, dir); err != nil {
		return nil, err
	}
	if _, err = git(ctx, dir, nil, "commit", "-q", "--allow-empty", "--no-verify", "-m", "factory-review: working tree state"); err != nil {
		return nil, err
	}
	return w, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, st.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// patch returns the diff of everything the agent changed since the seeded commit, new files included.
func (w *worktree) patch(ctx context.Context) (string, error) {
	if err := stageAll(ctx, w.dir); err != nil {
		return "", err
	}
	return git(ctx, w.dir, nil, "diff", "--cached", "--binary")
}

// remove deletes the worktree. It ignores cancellation so a timed-out or crashed run still cleans up,
// and falls back to removing the directory and pruning the repo's worktree list.
func (w *worktree) remove() {
	ctx := context.WithoutCancel(context.Background())
	if _, err := git(ctx, w.repo, nil, "worktree", "remove", "--force", w.dir); err != nil {
		_ = os.RemoveAll(w.dir)
		_, _ = git(ctx, w.repo, nil, "worktree", "prune")
	}
}
