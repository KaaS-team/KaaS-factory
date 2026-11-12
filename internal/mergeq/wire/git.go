// Package wire builds the merge queue's real adapters: git over gitx, the gate over internal/gate,
// pull request heads over go-github, and the tracker over internal/tracker/github.
package wire

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/KaaS-team/factory/internal/gitx"
	"github.com/KaaS-team/factory/internal/mergeq"
)

// Git is mergeq.Git over a clone whose Remote carries the base Branch. The base lives on the remote,
// so a second queue process and the GitHub UI see the same base this one moves.
type Git struct {
	G      gitx.Git
	Remote string // "origin" when empty
	Branch string // "main" when empty
}

var _ mergeq.Git = Git{}

func (g Git) remote() string { return orDefault(g.Remote, "origin") }
func (g Git) branch() string { return orDefault(g.Branch, "main") }

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// git runs git in the clone. gitx does not expose the plumbing Merge needs, so this is the one
// place the package shells out itself. It returns stdout and the exit code.
func (g Git) git(ctx context.Context, args ...string) (string, int, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = g.G.Dir
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	var ee *exec.ExitError
	switch {
	case err == nil:
		return out.String(), 0, nil
	case errors.As(err, &ee):
		return out.String(), ee.ExitCode(), fmt.Errorf("git %s: exit %d: %s", args[0], ee.ExitCode(), strings.TrimSpace(errb.String()))
	}
	return "", -1, fmt.Errorf("run git %s: %w", args[0], err)
}

func (g Git) must(ctx context.Context, args ...string) (string, error) {
	out, _, err := g.git(ctx, args...)
	return strings.TrimSpace(out), err
}

// Base returns the commit the remote's base branch points at now.
func (g Git) Base(ctx context.Context) (string, error) {
	sha, err := g.G.RemoteRef(ctx, g.remote(), "refs/heads/"+g.branch())
	if err != nil {
		return "", err
	}
	if sha == "" {
		return "", fmt.Errorf("wire: %s has no branch %s", g.remote(), g.branch())
	}
	return sha, nil
}

// have reports whether the commit is already in the local object store.
func (g Git) have(ctx context.Context, sha string) bool {
	_, code, _ := g.git(ctx, "cat-file", "-e", sha+"^{commit}")
	return code == 0
}

func (g Git) fetch(ctx context.Context, sha string) error {
	if g.have(ctx, sha) {
		return nil
	}
	_, err := g.must(ctx, "fetch", "-q", "--no-tags", g.remote(), sha)
	return err
}

// Merge merges heads, in order, onto the remote base into commits kept under refs/factory/mergeq,
// and returns that ref. A head that does not merge cleanly returns mergeq.ErrConflict.
func (g Git) Merge(ctx context.Context, heads []string) (mergeq.Merged, error) {
	base, err := g.Base(ctx)
	if err != nil {
		return mergeq.Merged{}, err
	}
	cur := base
	for _, h := range append([]string{base}, heads...) {
		if err := g.fetch(ctx, h); err != nil {
			return mergeq.Merged{}, err
		}
	}
	for _, h := range heads {
		out, code, err := g.git(ctx, "merge-tree", "--write-tree", "--no-messages", cur, h)
		if code == 1 {
			return mergeq.Merged{}, fmt.Errorf("%w: %s does not merge onto %s", mergeq.ErrConflict, short(h), short(cur))
		}
		if err != nil {
			return mergeq.Merged{}, err
		}
		tree := strings.TrimSpace(out)
		if cur, err = g.must(ctx, "-c", "user.name=factory", "-c", "user.email=factory@localhost", "-c", "commit.gpgsign=false",
			"commit-tree", tree, "-p", cur, "-p", h, "-m", "Merge "+short(h)+" (merge queue)"); err != nil {
			return mergeq.Merged{}, err
		}
	}
	ref := "refs/factory/mergeq/" + cur
	if err := g.G.UpdateRef(ctx, ref, cur, ""); err != nil && !errors.Is(err, gitx.ErrCASLost) {
		return mergeq.Merged{}, err
	}
	return mergeq.Merged{Ref: ref, Base: base}, nil
}

// FastForward pushes ref to the base branch. If the remote base moved so ref no longer descends
// from it, the push is refused and the result is mergeq.ErrBaseMoved.
func (g Git) FastForward(ctx context.Context, ref string) error {
	err := g.G.FFPush(ctx, g.remote(), ref, g.branch())
	if errors.Is(err, gitx.ErrNotFastForward) {
		return fmt.Errorf("%w: %w", mergeq.ErrBaseMoved, err)
	}
	return err
}

func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}
