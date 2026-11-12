// Package autosubmit stops a local agent run that passes its call or cost cap and, for that or any
// abnormal exit, collects the worktree's diff and opens a pull request marked partial.
//
// Caps and spend are operator-only: nothing here writes them into a PR.
package autosubmit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/KaaS-team/factory/internal/gitx"
	"os/exec"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
)

// Marker is the first line of every partial PR body.
const Marker = "<!-- factory:partial v1 -->"

// CallMargin is how far past Caps.Calls a run can get: the guard sees a call when its stream line
// arrives and kills the process group at once, so at most the call already in flight is over.
const CallMargin = 1

// ErrNothing means the worktree held no change against the base, so no PR was opened.
var ErrNothing = errors.New("autosubmit: nothing to submit")

// Reason is why a run is being submitted early.
type Reason string

// The reasons a run ends early.
const (
	CallCap Reason = "call-cap"
	CostCap Reason = "cost-cap"
	Died    Reason = "died"
)

// Caps limit one task. Zero means no cap.
type Caps struct {
	Calls int
	USD   float64
}

// Guard watches one run's stream-json lines against Caps.
type Guard struct {
	caps  Caps
	calls int
}

// Guard returns a fresh guard for one run.
func (s *Submitter) Guard() *Guard { return &Guard{caps: s.Caps} }

// Calls is the number of assistant calls seen so far.
func (g *Guard) Calls() int { return g.calls }

// Feed reads one stream-json line and returns the reason to stop the run, or "".
func (g *Guard) Feed(line []byte) Reason {
	var l struct {
		Type  string   `json:"type"`
		Cost  *float64 `json:"cost_usd"`
		Total *float64 `json:"total_cost_usd"`
	}
	if json.Unmarshal(line, &l) != nil {
		return ""
	}
	if l.Type == "assistant" {
		g.calls++
		if g.caps.Calls > 0 && g.calls >= g.caps.Calls {
			return CallCap
		}
	}
	cost := l.Total
	if cost == nil {
		cost = l.Cost
	}
	if cost != nil && g.caps.USD > 0 && *cost >= g.caps.USD {
		return CostCap
	}
	return ""
}

// PR is a pull request to open.
type PR struct {
	Repo, Head, Base, Title, Body string
	Draft                         bool
}

// PRs opens pull requests.
type PRs interface {
	Open(ctx context.Context, p PR) (url string, err error)
}

// Exit describes a run that ended early: its brief, its worktree and why.
type Exit struct {
	Brief  api.Brief
	Dir    string
	Reason Reason
}

// Submitter holds the caps and the PR port for local runs.
type Submitter struct {
	Caps Caps
	PRs  PRs
}

// Submit commits what is in the worktree, pushes the brief's branch and opens a draft PR marked
// partial. It returns ErrNothing when the worktree has no change against the base.
func (s *Submitter) Submit(ctx context.Context, e Exit) (string, error) {
	b := e.Brief
	gitOut := func(_ context.Context, args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "user.name=factory", "-c", "user.email=factory@localhost"}, args...)...)
		cmd.Dir = e.Dir
		var out, errb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errb
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("autosubmit: git %s: %w: %s", args[0], err, strings.TrimSpace(errb.String()))
		}
		return out.String(), nil
	}
	git := func(args ...string) error { _, err := gitOut(ctx, args...); return err }
	if err := gitx.StageAll(ctx, gitOut); err != nil {
		return "", err
	}
	if exec.CommandContext(ctx, "git", "-C", e.Dir, "diff", "--cached", "--quiet").Run() != nil { // staged work exists
		if err := git("commit", "-q", "--no-verify", "-m", fmt.Sprintf("partial: %s attempt %d", b.Ticket, b.Attempt)); err != nil {
			return "", err
		}
	}
	if exec.CommandContext(ctx, "git", "-C", e.Dir, "diff", "--quiet", "origin/"+b.Base, "HEAD").Run() == nil {
		return "", ErrNothing
	}
	if err := git("push", "-q", "--no-verify", "origin", "HEAD:refs/heads/"+b.Branch); err != nil {
		return "", err
	}
	return s.PRs.Open(ctx, PR{
		Repo: b.Repo, Head: b.Branch, Base: b.Base, Draft: true,
		Title: fmt.Sprintf("[partial] %s", b.Ticket),
		Body:  Marker + "\nThis pull request is partial. The session stopped before it finished, so the change may be incomplete. Review what is here, then finish it or retry the ticket.\n",
	})
}
