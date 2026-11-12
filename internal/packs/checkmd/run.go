// Ported from continuedev/continue@5522c6f extensions/cli/src/commands/review/worktree.ts

package checkmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Status is the outcome of one check.
type Status string

// The three outcomes: no patch, a patch, or the check could not finish.
const (
	Pass  Status = "pass"
	Fail  Status = "fail"
	Error Status = "error"
)

// Result is the record of one check run.
type Result struct {
	Name     string
	Status   Status
	Patch    string
	Output   string
	Duration time.Duration
}

// Agent runs a prompt with dir as its working directory and returns what it said.
type Agent interface {
	Run(ctx context.Context, dir, prompt string) (string, error)
}

// Runner runs each check in its own disposable worktree.
type Runner struct {
	Repo         string
	Agent        Agent
	Timeout      time.Duration // zero means no limit beyond ctx
	MaxDiffBytes int           // diff bytes shown in the prompt; zero means none
}

// Run runs every pack in turn and returns one Result each. An empty patch is a pass.
func (r Runner) Run(ctx context.Context, packs []Pack, files []string, diff string) []Result {
	out := make([]Result, 0, len(packs))
	for _, p := range packs {
		out = append(out, r.one(ctx, p, files, diff))
	}
	return out
}

func (r Runner) one(ctx context.Context, p Pack, files []string, diff string) (res Result) {
	res = Result{Name: p.Name, Status: Error}
	start := time.Now()
	defer func() { res.Duration = max(time.Since(start), time.Nanosecond) }()
	dir, err := r.worktree(ctx)
	if dir != "" {
		defer r.remove(dir)
	}
	if err != nil {
		res.Output = err.Error()
		return res
	}
	defer func() {
		if v := recover(); v != nil {
			res.Status, res.Output = Error, fmt.Sprintf("check crashed: %v", v)
		}
	}()
	actx := ctx
	if r.Timeout > 0 { // the limit covers the agent, not worktree setup
		var cancel context.CancelFunc
		actx, cancel = context.WithTimeout(ctx, r.Timeout)
		defer cancel()
	}
	out, err := r.Agent.Run(actx, dir, Prompt(p, files, diff, r.MaxDiffBytes))
	res.Output = out
	if errors.Is(actx.Err(), context.DeadlineExceeded) {
		res.Output = strings.TrimSpace(out + "\ntimeout after " + r.Timeout.String())
		return res
	}
	if err != nil {
		res.Output = strings.TrimSpace(out + "\n" + err.Error())
		return res
	}
	patch, err := r.git(ctx, dir, nil, "add", "-A")
	if err == nil {
		patch, err = r.git(ctx, dir, nil, "diff", "--cached", "--binary")
	}
	if err != nil {
		res.Output = strings.TrimSpace(out + "\n" + err.Error())
		return res
	}
	res.Patch = patch
	res.Status = Pass
	if patch != "" {
		res.Status = Fail
	}
	return res
}

func (r Runner) git(ctx context.Context, dir string, stdin []byte, args ...string) (string, error) {
	c := exec.CommandContext(ctx, "git", append([]string{"-c", "user.name=factory", "-c", "user.email=factory@localhost"}, args...)...)
	c.Dir = dir
	c.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
	if stdin != nil {
		c.Stdin = bytes.NewReader(stdin)
	}
	var o, e bytes.Buffer
	c.Stdout, c.Stderr = &o, &e
	if err := c.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(e.String()))
	}
	return o.String(), nil
}

// worktree makes a detached worktree at HEAD, applies the uncommitted changes and untracked files,
// and commits that state so the final diff holds only what the agent changed. It returns the
// directory even on error so the caller can remove it.
func (r Runner) worktree(ctx context.Context) (string, error) {
	dir, err := os.MkdirTemp("", "factory-check-")
	if err != nil {
		return "", err
	}
	if _, err := r.git(ctx, r.Repo, nil, "worktree", "add", "--detach", dir, "HEAD"); err != nil {
		return dir, err
	}
	diff, err := r.git(ctx, r.Repo, nil, "diff", "HEAD", "--binary")
	if err != nil {
		return dir, err
	}
	if diff != "" {
		if _, err := r.git(ctx, dir, []byte(diff), "apply", "--allow-empty", "-"); err != nil {
			return dir, err
		}
	}
	untracked, err := r.git(ctx, r.Repo, nil, "ls-files", "-z", "--others", "--exclude-standard")
	if err != nil {
		return dir, err
	}
	for _, f := range strings.Split(untracked, "\x00") {
		if f == "" {
			continue
		}
		info, err := os.Lstat(filepath.Join(r.Repo, f))
		if err != nil || !info.Mode().IsRegular() {
			continue // symlinks and vanished files stay out of the copy
		}
		b, err := os.ReadFile(filepath.Join(r.Repo, f))
		if err != nil {
			continue
		}
		dst := filepath.Join(dir, f)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return dir, err
		}
		if err := os.WriteFile(dst, b, info.Mode().Perm()); err != nil {
			return dir, err
		}
	}
	if _, err := r.git(ctx, dir, nil, "add", "-A"); err != nil {
		return dir, err
	}
	_, err = r.git(ctx, dir, nil, "commit", "-m", "factory: working tree state", "--allow-empty", "--no-verify")
	return dir, err
}

// remove deletes the worktree even when the run's context is already cancelled.
func (r Runner) remove(dir string) {
	ctx := context.WithoutCancel(context.Background())
	if _, err := r.git(ctx, r.Repo, nil, "worktree", "remove", "--force", dir); err != nil {
		_ = os.RemoveAll(dir)
		_, _ = r.git(ctx, r.Repo, nil, "worktree", "prune")
	}
}

// Prompt builds the review-only prompt: the diff, the four scope rules, then the pack body.
// The diff is cut at maxBytes with a notice.
func Prompt(p Pack, files []string, diff string, maxBytes int) string {
	var list strings.Builder
	for _, f := range files {
		list.WriteString("- " + f + "\n")
	}
	notice := ""
	if maxBytes > 0 && len(diff) > maxBytes {
		diff = diff[:maxBytes]
		notice = fmt.Sprintf("\nNote: the diff was truncated at %d bytes. You may read the changed files listed above, but do not explore beyond them.\n", maxBytes)
	}
	return fmt.Sprintf(`You are a check agent. Review ONLY the changed lines in the diff below against the check at the end.

## Scope
- Do NOT read, scan, or report on files outside the diff.
- Do NOT report pre-existing issues in unchanged code, even in files that appear in the diff.
- You may read surrounding code to understand a change, but flag only the changed lines.
- Edit only the changed files listed below, and only to fix a violation of this check. If there is none, edit nothing and say so.

### Changed files
%s
### Diff
`+"```diff\n%s\n```"+`%s
## Check: %s
%s`, strings.TrimSpace(list.String()), diff, notice, p.Name, p.Body)
}
