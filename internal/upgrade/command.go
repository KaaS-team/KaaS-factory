package upgrade

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/eval"
	"github.com/KaaS-team/factory/internal/packs"
)

// GitUpstream reads upstream state with the git binary: ls-remote for the head, packs.GitFetcher for files.
type GitUpstream struct {
	packs.GitFetcher
}

// Head returns the newest commit on the default branch of slug, from git ls-remote.
func (g GitUpstream) Head(ctx context.Context, slug string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "ls-remote", g.Remote(slug), "HEAD")
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git ls-remote: %w: %s", err, strings.TrimSpace(errb.String()))
	}
	f := strings.Fields(out.String())
	if len(f) == 0 {
		return "", fmt.Errorf("git ls-remote %s: no HEAD", slug)
	}
	return f[0], nil
}

// Scorer returns the scorecards of the pack before and after a candidate bump.
type Scorer interface {
	Score(ctx context.Context, c Candidate) (old, next eval.Scorecard, err error)
}

// Runner holds what the command needs; tests replace both fields with fakes.
type Runner struct {
	Upstream Upstream
	Scorer   Scorer
}

// Run plans, judges and (unless dryRun) applies every candidate in dir, and writes a line per candidate to out.
func (r Runner) Run(ctx context.Context, dir string, tolerance float64, dryRun bool, out func(string)) error {
	lock, err := packs.ReadLock(filepath.Join(dir, packs.LockFile))
	if err != nil {
		return err
	}
	cands, err := Plan(ctx, lock, r.Upstream)
	if err != nil {
		return err
	}
	if len(cands) == 0 {
		out("all packs are current")
		return nil
	}
	for _, c := range cands {
		old, next, err := r.Scorer.Score(ctx, c)
		if err != nil {
			return fmt.Errorf("score %s: %w", c.Old.Ref, err)
		}
		v := Judge(c, old, next, tolerance)
		verb := "refused"
		if v.Bump {
			verb = "bump"
		}
		out(fmt.Sprintf("%s %s: %s", verb, c.Old.Ref, v.Reason))
		if !v.Bump || dryRun {
			continue
		}
		if err := Apply(dir, lock, c, v, old, next); err != nil {
			return err
		}
	}
	return nil
}

// fileScorer reads two scorecard JSON files, so the eval can run elsewhere and the loop only compares.
type fileScorer struct{ old, next string }

func (f fileScorer) Score(context.Context, Candidate) (eval.Scorecard, eval.Scorecard, error) {
	var o, n eval.Scorecard
	for path, dst := range map[string]*eval.Scorecard{f.old: &o, f.next: &n} {
		b, err := os.ReadFile(path)
		if err != nil {
			return o, n, err
		}
		if err := json.Unmarshal(b, dst); err != nil {
			return o, n, fmt.Errorf("%s: %w", path, err)
		}
	}
	return o, n, nil
}

// NewCommand returns `upgrade`, meant to be mounted as `factory packs upgrade`.
func NewCommand() *cobra.Command {
	var (
		dryRun         bool
		tolerance      float64
		dir            string
		oldSC, nextSC  string
		cache, baseURL string
	)
	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Bump pinned packs to their newest upstream when the eval says it is not worse",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if oldSC == "" || nextSC == "" {
				return fmt.Errorf("--baseline and --candidate scorecard files are required")
			}
			r := Runner{
				Upstream: GitUpstream{packs.GitFetcher{
					Remote: func(slug string) string { return strings.TrimSuffix(baseURL, "/") + "/" + slug + ".git" },
					Cache:  cache,
				}},
				Scorer: fileScorer{old: oldSC, next: nextSC},
			}
			return r.Run(cmd.Context(), dir, tolerance, dryRun, func(s string) { _, _ = fmt.Fprintln(cmd.OutOrStdout(), s) })
		},
	}
	f := cmd.Flags()
	f.BoolVar(&dryRun, "dry-run", false, "report what would change and write nothing")
	f.Float64Var(&tolerance, "tolerance", DefaultTolerance, "largest allowed rise in tokens per merged PR, as a fraction")
	f.StringVar(&dir, "dir", ".", "directory holding factory.lock")
	f.StringVar(&oldSC, "baseline", "", "scorecard JSON of the pinned version")
	f.StringVar(&nextSC, "candidate", "", "scorecard JSON of the new version")
	f.StringVar(&baseURL, "remote", "https://github.com", "base URL packs are cloned from")
	f.StringVar(&cache, "cache", filepath.Join(os.TempDir(), "factory-packs"), "directory for cached bare repositories")
	return cmd
}
