package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/budget"
	"github.com/KaaS-team/factory/internal/config"
)

type countingDispatcher struct {
	api.Dispatcher
	calls int
}

func (c *countingDispatcher) Dispatch(context.Context, api.Brief) (api.Session, error) {
	c.calls++
	return api.Session{Key: "k"}, nil
}

// A team over its budget gets no agent session: the dispatcher the config builds refuses before it
// reaches the model stage, with a message that names the scope and the file to edit. Under the cap it runs.
func TestDispatchStopsWhenTheTeamIsOverBudget(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Cleanup(func() { budget.Configure(nil) })
	if err := os.MkdirAll(".factory/state", 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Clean(name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(budget.DefaultPath, "budgets:\n  - scope: team:acme\n    limit_usd: 5\n    period: month\n")
	at := time.Now().UTC().Format(time.RFC3339)
	write(spendPath, `[{"team":"acme","client":"web","at":"`+at+`","cost_usd":9}]`)

	inner := &countingDispatcher{}
	dispatchers["capped"] = func(context.Context, config.Config) (api.Dispatcher, error) { return inner, nil }
	t.Cleanup(func() { delete(dispatchers, "capped") })
	d, err := buildDispatcher(t.Context(), config.Config{Dispatcher: "capped"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.Dispatch(t.Context(), api.Brief{Repo: "acme/web"})
	if !errors.Is(err, budget.ErrOverBudget) || !strings.Contains(err.Error(), "team:acme") || !strings.Contains(err.Error(), budget.DefaultPath) {
		t.Fatalf("got %v", err)
	}
	if inner.calls != 0 {
		t.Fatalf("the agent was called %d times", inner.calls)
	}
	if _, err := d.Dispatch(t.Context(), api.Brief{Repo: "other/web"}); err != nil || inner.calls != 1 {
		t.Fatalf("a scope with no budget must run: %v, calls %d", err, inner.calls)
	}
}
