// Package gitx wraps the git binary for the operations the orchestrator and
// the merge queue need. It shells out; there is no libgit2.
package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// Errors a caller can branch on.
var (
	// ErrNotFastForward means the remote refused a push that would not fast-forward.
	ErrNotFastForward = errors.New("gitx: not a fast-forward")
	// ErrCASLost means a compare-and-swap found a ref that no longer holds the expected value.
	ErrCASLost = errors.New("gitx: ref changed, compare-and-swap lost")
)

// Git runs git commands in one repository directory.
type Git struct{ Dir string }

// New returns a Git bound to the repository at dir.
func New(dir string) Git { return Git{Dir: dir} }

type result struct {
	stdout, stderr string
	code           int
}

// run executes git and returns its output and exit code; err is set only when git could not run at all.
func (g Git) run(ctx context.Context, args ...string) (result, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = g.Dir
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	r := result{stdout: out.String(), stderr: errb.String()}
	var ee *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee):
		r.code = ee.ExitCode()
	default:
		return r, fmt.Errorf("gitx: run git %s: %w", args[0], err)
	}
	return r, nil
}

func (g Git) must(ctx context.Context, args ...string) (string, error) {
	r, err := g.run(ctx, args...)
	if err != nil {
		return "", err
	}
	if r.code != 0 {
		return "", fmt.Errorf("gitx: git %s: exit %d: %s", args[0], r.code, strings.TrimSpace(r.stderr))
	}
	return r.stdout, nil
}

// splitNUL splits NUL-terminated output into its non-empty fields.
func splitNUL(s string) []string {
	var out []string
	for _, f := range strings.Split(s, "\x00") {
		if f != "" {
			out = append(out, f)
		}
	}
	return out
}

// MergeTree merges a and b over the merge base `base` without touching the
// worktree or any ref, and returns the paths that conflict (nil when the
// merge is clean). It uses `git merge-tree --write-tree`, so it needs git 2.40.
func (g Git) MergeTree(ctx context.Context, base, a, b string) ([]string, error) {
	r, err := g.run(ctx, "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", "--merge-base="+base, a, b)
	if err != nil {
		return nil, err
	}
	switch r.code {
	case 0:
		return nil, nil
	case 1:
		// First field is the merged tree id; the rest are conflicted paths.
		// Exit 1 also covers a bad ref, so require the tree id git prints on a real conflict.
		fields := splitNUL(r.stdout)
		if len(fields) == 0 || !treeID.MatchString(fields[0]) {
			return nil, fmt.Errorf("gitx: git merge-tree: %s", strings.TrimSpace(r.stderr))
		}
		if len(fields) == 1 {
			return nil, nil
		}
		seen := map[string]bool{}
		var out []string
		for _, f := range fields[1:] {
			if !seen[f] {
				seen[f] = true
				out = append(out, f)
			}
		}
		return out, nil
	default:
		return nil, fmt.Errorf("gitx: git merge-tree: exit %d: %s", r.code, strings.TrimSpace(r.stderr))
	}
}

// DiffNames lists the paths head changed since it forked from base
// (`git diff --name-only base...head`), in git's order.
func (g Git) DiffNames(ctx context.Context, base, head string) ([]string, error) {
	out, err := g.must(ctx, "diff", "--name-only", "-z", base+"..."+head)
	if err != nil {
		return nil, err
	}
	return splitNUL(out), nil
}

// FFPush pushes the commit `src` to branch `branch` on `remote`. It never
// forces: a push that would rewrite the branch returns ErrNotFastForward.
func (g Git) FFPush(ctx context.Context, remote, src, branch string) error {
	r, err := g.run(ctx, "push", "--no-verify", "-q", remote, src+":refs/heads/"+branch)
	if err != nil {
		return err
	}
	if r.code == 0 {
		return nil
	}
	if strings.Contains(r.stderr, "non-fast-forward") || strings.Contains(r.stderr, "fetch first") || strings.Contains(r.stderr, "[rejected]") {
		return fmt.Errorf("%w: %s", ErrNotFastForward, strings.TrimSpace(r.stderr))
	}
	return fmt.Errorf("gitx: git push: exit %d: %s", r.code, strings.TrimSpace(r.stderr))
}

var treeID = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

// UpdateRef sets ref to newSha only if it currently holds oldSha
// (`git update-ref ref new old`). An empty oldSha means the ref must not exist.
// A mismatch returns ErrCASLost.
func (g Git) UpdateRef(ctx context.Context, ref, newSha, oldSha string) error {
	old := oldSha
	if old == "" {
		old = strings.Repeat("0", 40)
	}
	r, err := g.run(ctx, "update-ref", ref, newSha, old)
	if err != nil {
		return err
	}
	if r.code == 0 {
		return nil
	}
	return fmt.Errorf("%w: %s", ErrCASLost, strings.TrimSpace(r.stderr))
}

// RemoteRef returns the id ref points to on remote, or "" when it does not exist.
func (g Git) RemoteRef(ctx context.Context, remote, ref string) (string, error) {
	out, err := g.must(ctx, "ls-remote", remote, ref)
	if err != nil {
		return "", err
	}
	sha, _, _ := strings.Cut(strings.TrimSpace(out), "\t")
	return sha, nil
}
