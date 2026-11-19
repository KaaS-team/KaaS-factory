package github

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/audit"
	"github.com/KaaS-team/factory/internal/marker"
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
// returns the first id and posts nothing. A body carrying a request marker is matched on title and marker
// together, so two requests with the same first line stay two issues.
func (t *Tracker) Create(ctx context.Context, tk api.Ticket) (out api.TicketID, err error) {
	defer func() { audit.Record(ctx, "tracker.create_issue", tk.Title, string(out), err) }()
	if strings.TrimSpace(tk.Title) == "" {
		return "", errors.New("github tracker: create needs a title")
	}
	key := tk.Title
	if req := marker.Find(tk.Body, RequestMarker); len(req) > 0 {
		// A request ticket is the same ticket only if the whole request is the same, not its first line.
		key = tk.Title + "\x00" + req[0]
		if id, ok, err := t.findRequest(ctx, tk.Title, key, req[0]); err != nil {
			return "", err
		} else if ok {
			return id, nil
		}
	} else if id, ok, err := t.Find(ctx, tk.Title); err != nil {
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
	t.remember(key, id)
	return id, nil
}

// RequestMarker names the hidden marker whose payload is a hash of the whole request a ticket was filed from.
const RequestMarker = "request"

// findRequest is Find for a request ticket: an open issue with this title whose body carries the same request marker.
func (t *Tracker) findRequest(ctx context.Context, title, key, payload string) (api.TicketID, bool, error) {
	if id, ok := t.created(key); ok {
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
			if is.IsPullRequest() || is.GetTitle() != title {
				continue
			}
			for _, p := range marker.Find(is.GetBody(), RequestMarker) {
				if p == payload {
					return api.TicketID(strconv.Itoa(is.GetNumber())), true, nil
				}
			}
		}
		if resp.NextPage == 0 {
			return "", false, nil
		}
		opts.Page = resp.NextPage
	}
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
