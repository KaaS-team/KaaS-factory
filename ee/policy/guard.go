//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package policy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/KaaS-team/factory/internal/api"
)

// Guard returns a Control that checks the engine before Dispatch and Retry and writes one JSON
// audit line per decision to audit. A denied call returns an error and never reaches next.
func Guard(next api.Control, e *Engine, who Actor, audit io.Writer) api.Control {
	return &guard{Control: next, e: e, who: who, audit: audit}
}

type guard struct {
	api.Control
	e     *Engine
	who   Actor
	audit io.Writer
}

func (g *guard) Dispatch(ctx context.Context, id api.TicketID) error {
	if err := g.allow(ctx, ActionDispatch, id); err != nil {
		return err
	}
	return g.Control.Dispatch(ctx, id)
}

func (g *guard) Retry(ctx context.Context, id api.TicketID) error {
	if err := g.allow(ctx, ActionDispatch, id); err != nil {
		return err
	}
	return g.Control.Retry(ctx, id)
}

// allow looks up the ticket's repo, decides, and audits. A board that cannot be read leaves the
// repo empty, so only rules without a repos list can allow.
func (g *guard) allow(ctx context.Context, act Action, id api.TicketID) error {
	d := g.e.Check(ctx, g.who, act, Resource{Repo: g.repoOf(ctx, id)})
	line, _ := json.Marshal(map[string]any{
		"audit": "policy", "actor": g.who.ID, "role": g.who.Role, "action": act,
		"ticket": id, "allow": d.Allow, "rule": d.RuleID,
	})
	_, _ = fmt.Fprintf(g.audit, "%s\n", line)
	if !d.Allow {
		return fmt.Errorf("policy denied %s: %s", act, d.Reason)
	}
	return nil
}

func (g *guard) repoOf(ctx context.Context, id api.TicketID) string {
	b, err := g.Board(ctx)
	if err != nil {
		return ""
	}
	for _, t := range b.Ready {
		if t.ID == id {
			return t.Repo
		}
	}
	for _, s := range b.Slots {
		if s.Ticket.ID == id {
			return s.Ticket.Repo
		}
	}
	return ""
}
