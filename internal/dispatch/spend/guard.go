// Package spend stops a dispatcher from starting an agent session for a scope that has used up its
// budget. It sits in front of every dispatcher, so no run reaches the model stage over a cap.
package spend

import (
	"context"
	"fmt"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/budget"
)

// Wrap returns d with budget.Allow checked before every Dispatch. A scope with no budget, and a
// process with no configured guard, are allowed, so Wrap changes nothing until budgets exist.
func Wrap(d api.Dispatcher) api.Dispatcher { return guarded{d} }

type guarded struct{ api.Dispatcher }

// Scopes are the budget scopes a brief spends against: its team (the repo owner) and its client (the repo).
func scopes(b api.Brief) []string {
	owner, _, _ := strings.Cut(b.Repo, "/")
	var out []string
	if owner != "" {
		out = append(out, "team:"+owner)
	}
	if b.Repo != "" {
		out = append(out, "client:"+b.Repo)
	}
	return out
}

func (g guarded) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	for _, s := range scopes(b) {
		if err := budget.Allow(s); err != nil {
			return api.Session{}, fmt.Errorf("run stopped before the agent started: %w (raise the limit in %s to continue)", err, budget.DefaultPath)
		}
	}
	return g.Dispatcher.Dispatch(ctx, b)
}
