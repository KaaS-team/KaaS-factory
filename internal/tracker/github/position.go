package github

import (
	"context"
	"fmt"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/audit"
	"github.com/KaaS-team/factory/internal/marker"
	"github.com/KaaS-team/factory/internal/observe"
	"github.com/KaaS-team/factory/internal/tracker/sanitize"
	gogithub "github.com/google/go-github/v79/github"
)

var _ observe.Positioner = (*Tracker)(nil)

// positionComment is the runner's own comment that holds the ticket's position, if any.
func (t *Tracker) positionComment(ctx context.Context, n int) (Comment, bool, error) {
	cs, err := t.thread(ctx, n)
	if err != nil {
		return Comment{}, false, err
	}
	self, err := t.self(ctx)
	if err != nil {
		return Comment{}, false, err
	}
	own := ownBy(cs, self)
	for i := len(own) - 1; i >= 0; i-- {
		if _, ok := marker.LatestPosition(own[i].Body); ok {
			return own[i], true, nil
		}
	}
	return Comment{}, false, nil
}

// SavePosition writes the workflow position into one comment, edited in place, posted the first time.
func (t *Tracker) SavePosition(ctx context.Context, id api.TicketID, p observe.Position) (err error) {
	defer audit.Done(ctx, "tracker.save_position", string(id), string(id), &err)
	n, err := number(id)
	if err != nil {
		return err
	}
	prev, ok, err := t.positionComment(ctx, n)
	if err != nil {
		return err
	}
	body := marker.EncodePosition("Factory position: "+sanitize.Publication(p.Node, sanitize.DefaultOptions())+".", p)
	if !ok {
		return t.Comment(marker.Allow(ctx), id, body)
	}
	if _, _, err := t.client.Issues.EditComment(ctx, t.owner, t.repo, prev.ID, &gogithub.IssueComment{Body: &body}); err != nil {
		return fmt.Errorf("github tracker: write position of %d: %w", n, err)
	}
	return nil
}

// LoadPosition reads the position the runner last wrote on the issue.
func (t *Tracker) LoadPosition(ctx context.Context, id api.TicketID) (observe.Position, bool, error) {
	n, err := number(id)
	if err != nil {
		return observe.Position{}, false, err
	}
	c, ok, err := t.positionComment(ctx, n)
	if err != nil || !ok {
		return observe.Position{}, false, err
	}
	p, ok := marker.LatestPosition(c.Body)
	return p, ok, nil
}
