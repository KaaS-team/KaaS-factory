package github

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	gogithub "github.com/google/go-github/v79/github"
)

// queuedMarkerPrefix opens the comment marker the merge queue writes when it queues a PR.
const queuedMarkerPrefix = "<!-- factory:queued "

// comments lists every comment on issue n, oldest first, across pages.
func (t *Tracker) comments(ctx context.Context, n int) ([]*gogithub.IssueComment, error) {
	opts := &gogithub.IssueListCommentsOptions{
		Sort: gogithub.Ptr("created"), Direction: gogithub.Ptr("asc"),
		ListOptions: gogithub.ListOptions{PerPage: 100},
	}
	var out []*gogithub.IssueComment
	for {
		cs, resp, err := t.client.Issues.ListComments(ctx, t.owner, t.repo, n, opts)
		if err != nil {
			return nil, fmt.Errorf("github tracker: list comments of %d: %w", n, err)
		}
		out = append(out, cs...)
		if resp.NextPage == 0 {
			return out, nil
		}
		opts.Page = resp.NextPage
	}
}

// Comments returns the bodies of the issue's comments, oldest first. A comment carrying a queue
// marker is kept only when the tracker's own login wrote it: the merge queue merges the PR a marker
// names, so a marker anyone else posts (naming a fork PR, say) must never reach it.
func (t *Tracker) Comments(ctx context.Context, id api.TicketID) ([]string, error) {
	n, err := number(id)
	if err != nil {
		return nil, err
	}
	cs, err := t.comments(ctx, n)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		if ok, err := t.markerTrusted(ctx, c); err != nil {
			return nil, err
		} else if ok {
			out = append(out, c.GetBody())
		}
	}
	return out, nil
}

// markerTrusted reports whether c may be read: true for a comment with no queue marker, and for a
// marker comment only when the tracker's own login wrote it.
func (t *Tracker) markerTrusted(ctx context.Context, c *gogithub.IssueComment) (bool, error) {
	if !strings.Contains(c.GetBody(), queuedMarkerPrefix) {
		return true, nil
	}
	self, err := t.self(ctx)
	if err != nil {
		return false, err
	}
	return c.GetUser().GetLogin() == self, nil
}

// self returns the login the tracker's token acts as, fetched once.
func (t *Tracker) self(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.login != "" {
		return t.login, nil
	}
	u, _, err := t.client.Users.Get(ctx, "")
	if err != nil {
		return "", fmt.Errorf("github tracker: read own login: %w", err)
	}
	if u.GetLogin() == "" {
		return "", fmt.Errorf("github tracker: token has no login")
	}
	t.login = u.GetLogin()
	return t.login, nil
}

// labeledAt returns when label was last added to issue n, from its timeline.
func (t *Tracker) labeledAt(ctx context.Context, n int, label string) (time.Time, error) {
	opts := &gogithub.ListOptions{PerPage: 100}
	var at time.Time
	for {
		evs, resp, err := t.client.Issues.ListIssueTimeline(ctx, t.owner, t.repo, n, opts)
		if err != nil {
			return time.Time{}, fmt.Errorf("github tracker: timeline of %d: %w", n, err)
		}
		for _, e := range evs {
			if e.GetEvent() == "labeled" && e.GetLabel().GetName() == label && e.GetCreatedAt().After(at) {
				at = e.GetCreatedAt().Time
			}
		}
		if resp.NextPage == 0 {
			return at, nil
		}
		opts.Page = resp.NextPage
	}
}

// enqueuedAt returns when the first queue marker the tracker's own login wrote was commented on issue
// n, and false when there is none.
// The in-review label is shared by done and queued tickets, so the marker is what says a ticket is queued.
func (t *Tracker) enqueuedAt(ctx context.Context, n int) (time.Time, bool, error) {
	cs, err := t.comments(ctx, n)
	if err != nil {
		return time.Time{}, false, err
	}
	for _, c := range cs {
		if !strings.Contains(c.GetBody(), queuedMarkerPrefix) {
			continue
		}
		if ok, err := t.markerTrusted(ctx, c); err != nil {
			return time.Time{}, false, err
		} else if ok {
			return c.GetCreatedAt().Time, true, nil
		}
	}
	return time.Time{}, false, nil
}

// InPhase lists the open issues that show phase p, in the order they entered it: by when the phase
// label was added, read from the issue timeline. Phases that share a label are told apart only for
// queued, where the issue must also carry a queue marker comment and its first marker's time is
// the entry time (done and queued tickets share factory:in-review). Pull requests are skipped.
func (t *Tracker) InPhase(ctx context.Context, p api.Phase) ([]api.TicketID, error) {
	label := phaseLabel[p]
	if label == "" {
		return nil, fmt.Errorf("github tracker: phase %q has no label to list by", p)
	}
	type entry struct {
		n  int
		at time.Time
	}
	var found []entry
	opts := &gogithub.IssueListByRepoOptions{
		State: "open", Labels: []string{label}, Sort: "created", Direction: "asc",
		ListOptions: gogithub.ListOptions{PerPage: 100},
	}
	for {
		issues, resp, err := t.client.Issues.ListByRepo(ctx, t.owner, t.repo, opts)
		if err != nil {
			return nil, fmt.Errorf("github tracker: list %s issues: %w", p, err)
		}
		for _, is := range issues {
			if is.IsPullRequest() {
				continue
			}
			var at time.Time
			if p == api.PhaseQueued {
				var ok bool
				if at, ok, err = t.enqueuedAt(ctx, is.GetNumber()); err != nil {
					return nil, err
				} else if !ok {
					continue
				}
			} else if at, err = t.labeledAt(ctx, is.GetNumber(), label); err != nil {
				return nil, err
			}
			found = append(found, entry{is.GetNumber(), at})
		}
		if resp.NextPage == 0 {
			break
		}
		opts.ListOptions.Page = resp.NextPage
	}
	sort.SliceStable(found, func(i, j int) bool {
		if !found[i].at.Equal(found[j].at) {
			return found[i].at.Before(found[j].at)
		}
		return found[i].n < found[j].n
	})
	out := make([]api.TicketID, 0, len(found))
	for _, e := range found {
		out = append(out, api.TicketID(fmt.Sprint(e.n)))
	}
	return out, nil
}
