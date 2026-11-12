package github

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/plancmd"
	gogithub "github.com/google/go-github/v79/github"
)

var _ plancmd.Filer = (*Tracker)(nil)

// Find searches the repository's open issues for one with exactly this title. The search API
// matches loosely, so each hit is compared exactly and pull requests are ignored.
func (t *Tracker) Find(ctx context.Context, title string) (api.TicketID, bool, error) {
	if title == "" {
		return "", false, errors.New("github tracker: find needs a title")
	}
	if id, ok := t.created(title); ok {
		return id, true, nil
	}
	q := fmt.Sprintf("repo:%s/%s is:issue is:open in:title %s", t.owner, t.repo, strconv.Quote(title))
	opts := &gogithub.SearchOptions{ListOptions: gogithub.ListOptions{PerPage: 100}}
	for {
		res, resp, err := t.client.Search.Issues(ctx, q, opts)
		if err != nil {
			return "", false, fmt.Errorf("github tracker: search %q: %w", title, err)
		}
		for _, is := range res.Issues {
			if !is.IsPullRequest() && is.GetTitle() == title {
				return api.TicketID(strconv.Itoa(is.GetNumber())), true, nil
			}
		}
		if resp.NextPage == 0 {
			return "", false, nil
		}
		opts.Page = resp.NextPage
	}
}

// Create files t as an open issue and returns its number. The body is posted as given, so a planned
// body v1 (with its Files and Blocked by lines) reaches GitHub byte for byte. With no labels the
// issue gets factory:ready. A title already filed, found by search or created by this Tracker,
// returns the first id and posts nothing.
func (t *Tracker) Create(ctx context.Context, tk api.Ticket) (api.TicketID, error) {
	if strings.TrimSpace(tk.Title) == "" {
		return "", errors.New("github tracker: create needs a title")
	}
	if id, ok, err := t.Find(ctx, tk.Title); err != nil {
		return "", err
	} else if ok {
		return id, nil
	}
	labels := tk.Labels
	if len(labels) == 0 {
		labels = []string{LabelReady}
	}
	is, _, err := t.client.Issues.Create(ctx, t.owner, t.repo, &gogithub.IssueRequest{
		Title: &tk.Title, Body: &tk.Body, Labels: &labels,
	})
	if err != nil {
		return "", fmt.Errorf("github tracker: create %q: %w", tk.Title, err)
	}
	id := api.TicketID(strconv.Itoa(is.GetNumber()))
	t.remember(tk.Title, id)
	return id, nil
}

func (t *Tracker) created(title string) (api.TicketID, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	id, ok := t.filed[title]
	return id, ok
}

// remember keeps the id of a title this Tracker filed, because the search index lags a fresh issue.
func (t *Tracker) remember(title string, id api.TicketID) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.filed == nil {
		t.filed = map[string]api.TicketID{}
	}
	t.filed[title] = id
}
