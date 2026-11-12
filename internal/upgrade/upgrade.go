// Package upgrade keeps pinned packs current from their upstreams, bumping a pin only when the eval says the new version is not worse.
package upgrade

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/KaaS-team/factory/internal/eval"
	"github.com/KaaS-team/factory/internal/packs"
)

// DefaultTolerance is how much tokens per merged PR may rise before a bump is refused (5 percent).
const DefaultTolerance = 0.05

// Names of the files Apply writes next to the lock.
const (
	PRBodyFile   = "upgrade-pr-body.md"
	OperatorFile = "upgrade-operator.md"
)

// Upstream reads the newest state of a repository. Head returns the newest commit on its default
// branch; Fetch reads one file and the repository licence at a revision.
type Upstream interface {
	Head(ctx context.Context, slug string) (string, error)
	packs.Fetcher
}

// Candidate is a lock entry with a newer upstream version whose file content differs.
type Candidate struct {
	Old packs.Entry
	New packs.Entry
}

// Plan returns one candidate per lock entry whose upstream sha changed and whose file hash changed.
func Plan(ctx context.Context, lock *packs.Lock, up Upstream) ([]Candidate, error) {
	var out []Candidate
	for _, e := range lock.Entries {
		ref, err := packs.ParseRef(e.Ref)
		if err != nil {
			return nil, err
		}
		head, err := up.Head(ctx, ref.Slug())
		if err != nil {
			return nil, fmt.Errorf("head %s: %w", ref.Slug(), err)
		}
		if head == "" || head == e.SHA {
			continue
		}
		f, err := up.Fetch(ctx, ref.Slug(), head, ref.Path)
		if err != nil {
			return nil, fmt.Errorf("fetch %s at %s: %w", ref, head, err)
		}
		h := sha256.Sum256(f.Content)
		digest := hex.EncodeToString(h[:])
		if digest == e.SHA256 {
			continue
		}
		sha := f.SHA
		if sha == "" {
			sha = head
		}
		n := packs.Entry{
			Kind:    e.Kind,
			Ref:     packs.Ref{Owner: ref.Owner, Repo: ref.Repo, SHA: sha, Path: ref.Path}.String(),
			SHA:     sha,
			SHA256:  digest,
			Licence: f.Licence,
		}
		out = append(out, Candidate{Old: e, New: n})
	}
	return out, nil
}

// Verdict says whether to bump and why.
type Verdict struct {
	Bump   bool
	Reason string
}

// Decide bumps unless eval.Compare finds the new scorecard worse than the old (tolerance is the
// allowed rise in tokens per merged PR as a fraction; zero or less means DefaultTolerance).
func Decide(old, next eval.Scorecard, tolerance float64) Verdict {
	if tolerance <= 0 {
		tolerance = DefaultTolerance
	}
	if v := eval.Compare(old, next, tolerance); v.Worse {
		return Verdict{Reason: v.Reason}
	}
	return Verdict{Bump: true, Reason: fmt.Sprintf("pass rate not lower and tokens per merged PR within %.0f%%", tolerance*100)}
}

// Judge refuses a candidate whose new licence is not allowed, and otherwise returns Decide.
func Judge(c Candidate, old, next eval.Scorecard, tolerance float64) Verdict {
	if err := packs.CheckLicence(c.New.Licence); err != nil {
		return Verdict{Reason: fmt.Sprintf("licence changed from %s to %s: %v", c.Old.Licence, c.New.Licence, err)}
	}
	return Decide(old, next, tolerance)
}

// Apply replaces the candidate's entry in lock, writes factory.lock in dir, and writes the PR body
// (no token counts, cost or model) and the operator file (scorecard diff) next to it.
// It refuses a verdict that does not bump.
func Apply(dir string, lock *packs.Lock, c Candidate, v Verdict, old, next eval.Scorecard) error {
	if !v.Bump {
		return fmt.Errorf("upgrade of %s refused: %s", c.Old.Ref, v.Reason)
	}
	if err := lock.Put(c.New); err != nil {
		return err
	}
	if err := packs.WriteLock(filepath.Join(dir, packs.LockFile), lock); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, PRBodyFile), []byte(prBody(c, v, old, next)), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, OperatorFile), []byte(operatorDiff(c, old, next)), 0o644)
}

func short(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

func prBody(c Candidate, v Verdict, old, next eval.Scorecard) string {
	var b strings.Builder
	fmt.Fprintf(&b, "## Pack upgrade\n\nBumps `%s` from `%s` to `%s`.\n\n", c.Old.Ref, short(c.Old.SHA), short(c.New.SHA))
	fmt.Fprintf(&b, "Decision: %s.\n\n", sanitize(v.Reason))
	b.WriteString("| | Before | After |\n|---|---|---|\n")
	fmt.Fprintf(&b, "| Pass rate | %.2f | %.2f |\n", old.Aggregate.PassRate, next.Aggregate.PassRate)
	fmt.Fprintf(&b, "| Licence | %s | %s |\n", c.Old.Licence, c.New.Licence)
	return b.String()
}

// sanitize keeps the token figures of a refusal reason out of customer text.
func sanitize(reason string) string {
	if strings.Contains(reason, "tokens") {
		return "pass rate not lower and cost within tolerance"
	}
	return reason
}

func operatorDiff(c Candidate, old, next eval.Scorecard) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Upgrade scorecard diff\n\n%s\n\n", c.Old.Ref)
	fmt.Fprintf(&b, "- Model: %s -> %s\n", old.Model, next.Model)
	fmt.Fprintf(&b, "- Pass rate: %.2f -> %.2f\n", old.Aggregate.PassRate, next.Aggregate.PassRate)
	fmt.Fprintf(&b, "- Tokens per merged PR: %d -> %d\n\n", old.Aggregate.TokensPerMergedPR, next.Aggregate.TokensPerMergedPR)
	b.WriteString("## Before\n\n" + eval.Markdown(old, false) + "\n## After\n\n" + eval.Markdown(next, false))
	return b.String()
}
