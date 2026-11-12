// Package ghsource implements observe.Source on the GitHub REST API.
package ghsource

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/KaaS-team/factory/internal/observe"
	gogithub "github.com/google/go-github/v79/github"
)

const perPage = 100

// Source reads one repository's branches, pull requests and checks from GitHub.
type Source struct {
	client      *gogithub.Client
	owner, repo string
	base        string
}

var _ observe.Source = (*Source)(nil)

// New returns a Source for owner/repo whose diffs are taken against base.
func New(client *gogithub.Client, owner, repo, base string) *Source {
	return &Source{client: client, owner: owner, repo: repo, base: base}
}

// RateLimitedError says GitHub refused a call because the rate limit is spent, and when it resets.
type RateLimitedError struct{ Reset time.Time }

// Error names the reset time.
func (e *RateLimitedError) Error() string {
	return "github rate limit exceeded, resets at " + e.Reset.UTC().Format(time.RFC3339)
}

// wrap turns a rate-limited reply into RateLimitedError and leaves other errors alone. It reads
// the headers itself because GetBranch follows redirects by hand and skips go-github's own check.
func wrap(resp *gogithub.Response, err error) error {
	var rl *gogithub.RateLimitError
	if errors.As(err, &rl) {
		return &RateLimitedError{Reset: rl.Rate.Reset.Time}
	}
	if err != nil && resp != nil && resp.StatusCode == http.StatusForbidden && resp.Rate.Remaining == 0 && !resp.Rate.Reset.IsZero() {
		return &RateLimitedError{Reset: resp.Rate.Reset.Time}
	}
	return err
}

// Branch reports whether the branch exists and the committer date of its head commit.
func (s *Source) Branch(ctx context.Context, name string) (time.Time, bool, error) {
	b, resp, err := s.client.Repositories.GetBranch(ctx, s.owner, s.repo, name, 1)
	if resp != nil && resp.StatusCode == http.StatusNotFound {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, wrap(resp, fmt.Errorf("get branch %s: %w", name, err))
	}
	return b.GetCommit().GetCommit().GetCommitter().GetDate().Time, true, nil
}

// PullRequest finds the newest pull request, open or not, whose head is the branch.
func (s *Source) PullRequest(ctx context.Context, head string) (observe.PR, bool, error) {
	prs, resp, err := s.client.PullRequests.List(ctx, s.owner, s.repo, &gogithub.PullRequestListOptions{
		Head: s.owner + ":" + head, State: "all", Sort: "created", Direction: "desc",
		ListOptions: gogithub.ListOptions{PerPage: 1},
	})
	if err != nil {
		return observe.PR{}, false, wrap(resp, fmt.Errorf("list pull requests for %s: %w", head, err))
	}
	if len(prs) == 0 {
		return observe.PR{}, false, nil
	}
	return observe.PR{Number: prs[0].GetNumber(), Open: prs[0].GetState() == "open"}, true, nil
}

// Checks rolls up the check runs and legacy statuses on the pull request's head commit.
// A failure wins over pending, pending over pass, and no reports at all is ChecksNone.
func (s *Source) Checks(ctx context.Context, pr int) (observe.Checks, error) {
	p, resp, err := s.client.PullRequests.Get(ctx, s.owner, s.repo, pr)
	if err != nil {
		return observe.ChecksNone, wrap(resp, fmt.Errorf("get pull request %d: %w", pr, err))
	}
	sha := p.GetHead().GetSHA()

	var failed, pending, seen bool
	opts := &gogithub.ListCheckRunsOptions{ListOptions: gogithub.ListOptions{PerPage: perPage}}
	for {
		res, resp, err := s.client.Checks.ListCheckRunsForRef(ctx, s.owner, s.repo, sha, opts)
		if err != nil {
			return observe.ChecksNone, wrap(resp, fmt.Errorf("list check runs: %w", err))
		}
		for _, r := range res.CheckRuns {
			seen = true
			if r.GetStatus() != "completed" {
				pending = true
				continue
			}
			switch r.GetConclusion() {
			case "success", "neutral", "skipped":
			default:
				failed = true
			}
		}
		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}

	lopts := &gogithub.ListOptions{PerPage: perPage}
	for {
		st, resp, err := s.client.Repositories.GetCombinedStatus(ctx, s.owner, s.repo, sha, lopts)
		if err != nil {
			return observe.ChecksNone, wrap(resp, fmt.Errorf("get combined status: %w", err))
		}
		for _, c := range st.Statuses {
			seen = true
			switch c.GetState() {
			case "success":
			case "pending":
				pending = true
			default:
				failed = true
			}
		}
		if resp.NextPage == 0 {
			break
		}
		lopts.Page = resp.NextPage
	}

	switch {
	case failed:
		return observe.ChecksRed, nil
	case pending:
		return observe.ChecksPending, nil
	case seen:
		return observe.ChecksGreen, nil
	}
	return observe.ChecksNone, nil
}

// DiffFiles lists the names of the files the branch changes against the base, across every page.
func (s *Source) DiffFiles(ctx context.Context, branch string) ([]string, error) {
	var names []string
	opts := &gogithub.ListOptions{PerPage: perPage}
	for {
		cmp, resp, err := s.client.Repositories.CompareCommits(ctx, s.owner, s.repo, s.base, branch, opts)
		if err != nil {
			return nil, wrap(resp, fmt.Errorf("compare %s...%s: %w", s.base, branch, err))
		}
		for _, f := range cmp.Files {
			names = append(names, f.GetFilename())
		}
		if resp.NextPage == 0 {
			return names, nil
		}
		opts.Page = resp.NextPage
	}
}
