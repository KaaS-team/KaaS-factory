package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/dispatch/local"
	"github.com/KaaS-team/factory/internal/packs/checkmd"
	"github.com/KaaS-team/factory/internal/review"
)

// checksDir holds the markdown check packs `factory review` runs, one file per check.
const checksDir = ".factory/checks"

// reviewAgent is the agent each check runs under; tests replace it.
var reviewAgent review.Agent = claudeAgent{bin: "claude"}

// claudeAgent runs one check as a build-stage turn of the operator's own agent binary in the
// check's worktree, so it can edit there. Nothing leaves the worktree: the edits come back as a patch.
type claudeAgent struct {
	bin    string
	budget float64
}

func (a claudeAgent) Run(ctx context.Context, dir, prompt string) (string, error) {
	argv, err := local.ClaudeArgv(local.ClaudeInput{Stage: "build", Issue: "review", MaxBudgetUSD: a.budget, Prompt: prompt})
	if err != nil {
		return "", err
	}
	cmd := exec.CommandContext(ctx, a.bin, argv[1:]...)
	cmd.Dir = dir
	cmd.Env = local.ChildEnv(os.Environ(), local.ClaudePreset.Env)
	cmd.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return string(out), fmt.Errorf("running %s: %w: %s", a.bin, err, strings.TrimSpace(stderr.String()))
	}
	return string(out), nil
}

// packSource lists the check packs under repo whose globs and regexes match the working tree's
// changes against HEAD, uncommitted and untracked files included.
type packSource struct{ repo string }

func (s packSource) Checks(ctx context.Context) ([]review.Check, error) {
	files, err := filepath.Glob(filepath.Join(s.repo, checksDir, "*.md"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	var packs []checkmd.Pack
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		p, err := checkmd.Parse("", b)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		packs = append(packs, p)
	}
	changed, err := s.changed(ctx)
	if err != nil {
		return nil, err
	}
	contents := map[string]string{}
	for _, f := range changed {
		if b, err := os.ReadFile(filepath.Join(s.repo, f)); err == nil {
			contents[f] = string(b)
		}
	}
	var out []review.Check
	for _, p := range checkmd.Select(packs, changed, contents) {
		out = append(out, review.Check{Name: p.Name, Instructions: p.Body})
	}
	return out, nil
}

func (s packSource) changed(ctx context.Context) ([]string, error) {
	var all []string
	for _, args := range [][]string{{"diff", "--name-only", "HEAD"}, {"ls-files", "--others", "--exclude-standard"}} {
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = s.repo
		out, err := cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("git %s: %w", args[0], err)
		}
		all = append(all, strings.Fields(string(out))...)
	}
	return all, nil
}

// reviewCmd is `factory review`: every check pack that covers the working tree's changes runs once
// in its own disposable worktree. It fails when a check leaves a patch or cannot finish.
func reviewCmd() *cobra.Command {
	var base string
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "review",
		Short: "Run the check packs in " + checksDir + " against the uncommitted changes, edits returned as patches",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var budget float64
			if l, err := loadConfig(nil); err == nil {
				budget = l.Config.Budgets.Node
			}
			agent := reviewAgent
			if c, ok := agent.(claudeAgent); ok {
				c.budget = budget
				agent = c
			}
			res, err := review.Runner{Repo: ".", Source: packSource{repo: "."}, Agent: agent, Base: base, Timeout: timeout}.Run(cmd.Context())
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			bad := 0
			for _, r := range res {
				_, _ = fmt.Fprintf(out, "%s\t%s\n", r.Status, r.Name)
				if r.Status != review.StatusPass {
					bad++
				}
				if r.Patch != "" {
					_, _ = fmt.Fprintln(out, r.Patch)
				}
			}
			if bad > 0 {
				return errors.New("review: " + fmt.Sprint(bad) + " of " + fmt.Sprint(len(res)) + " checks did not pass")
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&base, "base", "", "ref the prompt's diff starts from (empty: only the uncommitted changes)")
	cmd.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "limit per check")
	return cmd
}
