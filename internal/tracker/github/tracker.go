package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"sync"

	"github.com/KaaS-team/factory/internal/api"
	gogithub "github.com/google/go-github/v79/github"
)

// Config says which repository to track and how to reach GitHub. Auth lives in
// HTTPClient (an injected transport), never in this package.
type Config struct {
	Owner, Repo string
	// HTTPClient carries the credentials; nil uses http.DefaultClient.
	HTTPClient *http.Client
	// BaseURL overrides the API root (GitHub Enterprise, or a test server). Empty means api.github.com.
	BaseURL string
}

// Tracker is the GitHub issue thread as an api.Tracker.
type Tracker struct {
	client      *gogithub.Client
	owner, repo string

	mu    sync.Mutex
	filed map[string]api.TicketID // titles Create filed; the search index lags a fresh issue
}

var (
	_ api.Tracker = (*Tracker)(nil)
	_ api.Lister  = (*Tracker)(nil)
)

// New returns a Tracker for cfg.Owner/cfg.Repo.
func New(cfg Config) (*Tracker, error) {
	if cfg.Owner == "" || cfg.Repo == "" {
		return nil, errors.New("github tracker: owner and repo are required")
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = http.DefaultClient
	}
	c := gogithub.NewClient(hc)
	if cfg.BaseURL != "" {
		u, err := url.Parse(cfg.BaseURL)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil, fmt.Errorf("github tracker: bad base URL %q", cfg.BaseURL)
		}
		c.BaseURL = u
	}
	return &Tracker{client: c, owner: cfg.Owner, repo: cfg.Repo}, nil
}

// Name returns "github".
func (t *Tracker) Name() string { return "github" }

func (t *Tracker) ticket(is *gogithub.Issue) api.Ticket {
	labels := make([]string, 0, len(is.Labels))
	for _, l := range is.Labels {
		labels = append(labels, l.GetName())
	}
	return api.Ticket{
		ID:        api.TicketID(strconv.Itoa(is.GetNumber())),
		Repo:      t.owner + "/" + t.repo,
		Title:     is.GetTitle(),
		Body:      is.GetBody(),
		Labels:    labels,
		CreatedAt: is.GetCreatedAt().Time,
	}
}

// number parses a ticket id into an issue number; anything but a positive integer is refused before a request is made.
func number(id api.TicketID) (int, error) {
	n, err := strconv.Atoi(string(id))
	if err != nil || n <= 0 || strconv.Itoa(n) != string(id) {
		return 0, fmt.Errorf("github tracker: ticket id %q is not an issue number", id)
	}
	return n, nil
}

// Ready lists the open issues that carry the factory:ready label, oldest first. Pull requests are skipped.
func (t *Tracker) Ready(ctx context.Context) ([]api.Ticket, error) {
	opts := &gogithub.IssueListByRepoOptions{
		State: "open", Labels: []string{LabelReady}, Sort: "created", Direction: "asc",
		ListOptions: gogithub.ListOptions{PerPage: 100},
	}
	var out []api.Ticket
	for {
		issues, resp, err := t.client.Issues.ListByRepo(ctx, t.owner, t.repo, opts)
		if err != nil {
			return nil, fmt.Errorf("github tracker: list ready issues: %w", err)
		}
		for _, is := range issues {
			if !is.IsPullRequest() {
				out = append(out, t.ticket(is))
			}
		}
		if resp.NextPage == 0 {
			return out, nil
		}
		opts.ListOptions.Page = resp.NextPage
	}
}

// Active lists open issues labeled factory:building or factory:verifying, oldest first, in one
// paged query (the issues API cannot OR labels, so the label test is made here). Ready, in-review
// and parked issues are not active. Pull requests are skipped.
func (t *Tracker) Active(ctx context.Context) ([]api.Ticket, error) {
	opts := &gogithub.IssueListByRepoOptions{
		State: "open", Sort: "created", Direction: "asc",
		ListOptions: gogithub.ListOptions{PerPage: 100},
	}
	var out []api.Ticket
	for {
		issues, resp, err := t.client.Issues.ListByRepo(ctx, t.owner, t.repo, opts)
		if err != nil {
			return nil, fmt.Errorf("github tracker: list active issues: %w", err)
		}
		for _, is := range issues {
			if is.IsPullRequest() {
				continue
			}
			for _, l := range is.Labels {
				if n := l.GetName(); n == LabelBuilding || n == LabelVerifying {
					out = append(out, t.ticket(is))
					break
				}
			}
		}
		if resp.NextPage == 0 {
			return out, nil
		}
		opts.ListOptions.Page = resp.NextPage
	}
}

// Get reads one issue. A pull request number is an error.
func (t *Tracker) Get(ctx context.Context, id api.TicketID) (api.Ticket, error) {
	n, err := number(id)
	if err != nil {
		return api.Ticket{}, err
	}
	is, _, err := t.client.Issues.Get(ctx, t.owner, t.repo, n)
	if err != nil {
		return api.Ticket{}, fmt.Errorf("github tracker: get issue %d: %w", n, err)
	}
	if is.IsPullRequest() {
		return api.Ticket{}, fmt.Errorf("github tracker: %d is a pull request, not a ticket", n)
	}
	return t.ticket(is), nil
}

// Comment posts body on the issue thread.
func (t *Tracker) Comment(ctx context.Context, id api.TicketID, body string) error {
	n, err := number(id)
	if err != nil {
		return err
	}
	if _, _, err := t.client.Issues.CreateComment(ctx, t.owner, t.repo, n, &gogithub.IssueComment{Body: &body}); err != nil {
		return fmt.Errorf("github tracker: comment on %d: %w", n, err)
	}
	return nil
}

// SetPhase swaps the issue's lifecycle label for the one that shows phase. It
// removes only labels the factory owns (see OwnsLabel) and leaves type,
// provenance and human labels alone.
func (t *Tracker) SetPhase(ctx context.Context, id api.TicketID, p api.Phase) error {
	target, known := phaseLabel[p]
	if !known {
		return fmt.Errorf("github tracker: unknown phase %q", p)
	}
	n, err := number(id)
	if err != nil {
		return err
	}
	is, _, err := t.client.Issues.Get(ctx, t.owner, t.repo, n)
	if err != nil {
		return fmt.Errorf("github tracker: read labels of %d: %w", n, err)
	}
	has := false
	for _, l := range is.Labels {
		name := l.GetName()
		switch {
		case name == target:
			has = true
		case OwnsLabel(name):
			if _, err := t.client.Issues.RemoveLabelForIssue(ctx, t.owner, t.repo, n, name); err != nil {
				return fmt.Errorf("github tracker: remove %s from %d: %w", name, n, err)
			}
		}
	}
	if target != "" && !has {
		if _, _, err := t.client.Issues.AddLabelsToIssue(ctx, t.owner, t.repo, n, []string{target}); err != nil {
			return fmt.Errorf("github tracker: add %s to %d: %w", target, n, err)
		}
	}
	return nil
}
