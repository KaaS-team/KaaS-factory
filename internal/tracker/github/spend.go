package github

import (
	"context"
	"fmt"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/marker"
	"github.com/KaaS-team/factory/internal/meter"
	gogithub "github.com/google/go-github/v79/github"
)

var _ meter.Thread = (*Tracker)(nil)

// spendComment returns the spend ledger comment the tracker's own login wrote on issue n, if any.
func (t *Tracker) spendComment(ctx context.Context, n int) (*gogithub.IssueComment, error) {
	cs, err := t.comments(ctx, n)
	if err != nil {
		return nil, err
	}
	var self string
	for _, c := range cs {
		if !strings.Contains(c.GetBody(), "<!-- factory:spend ") {
			continue
		}
		if self == "" {
			if self, err = t.self(ctx); err != nil {
				return nil, err
			}
		}
		if c.GetUser().GetLogin() == self {
			return c, nil
		}
	}
	return nil, nil
}

// SpendComment returns the body of the spend ledger comment on the issue, or "" when none exists.
func (t *Tracker) SpendComment(ctx context.Context, id api.TicketID) (string, error) {
	n, err := number(id)
	if err != nil {
		return "", err
	}
	c, err := t.spendComment(ctx, n)
	if err != nil || c == nil {
		return "", err
	}
	return c.GetBody(), nil
}

// PutSpendComment edits the issue's spend ledger comment in place, or posts it the first time.
func (t *Tracker) PutSpendComment(ctx context.Context, id api.TicketID, body string) error {
	n, err := number(id)
	if err != nil {
		return err
	}
	c, err := t.spendComment(ctx, n)
	if err != nil {
		return err
	}
	if c == nil {
		return t.Comment(marker.Allow(ctx), id, body)
	}
	if _, _, err := t.client.Issues.EditComment(ctx, t.owner, t.repo, c.GetID(), &gogithub.IssueComment{Body: &body}); err != nil {
		return fmt.Errorf("github tracker: edit spend comment on %d: %w", n, err)
	}
	return nil
}
