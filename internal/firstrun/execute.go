package firstrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
)

// notMeasured is written wherever an actual value is unknown. Zero would read as a real measurement.
const notMeasured = "not measured"

// PROpener opens one draft pull request and returns its number.
type PROpener interface {
	OpenDraft(ctx context.Context, branch, base, title, body string) (int, error)
}

// Exec is what Execute needs to dispatch the first fix and open its pull request.
type Exec struct {
	Dispatcher api.Dispatcher
	PRs        PROpener
	// Observer, when set, supplies the gate result; without it gates read "not measured".
	Observer api.Observer
	Repo     string
	Base     string
	// Branch overrides the default factory/<ticket>-a1 branch name.
	Branch string
	// Model and Agent go on the brief only, never into the pull request.
	Model string
	Agent string
}

// Scorecard holds estimate and actual side by side. An actual that was not measured is the string "not measured".
type Scorecard struct {
	Finding         string
	EstimateTokens  int
	EstimateMinutes int
	ActualTokens    *int64
	ActualMinutes   *int
	GatesGreen      *bool
	HumanTouches    *int
}

// Result is what Execute did.
type Result struct {
	// Plan says what a dry run would do; empty after a real run.
	Plan      string
	Session   api.Session
	PR        int
	Scorecard Scorecard
}

func orNot[T any](p *T) any {
	if p == nil {
		return notMeasured
	}
	return *p
}

// JSON renders the scorecard with estimate and actual side by side.
func (s Scorecard) JSON() ([]byte, error) {
	return json.MarshalIndent(map[string]any{
		"finding":       s.Finding,
		"estimate":      map[string]any{"tokens": s.EstimateTokens, "minutes": s.EstimateMinutes},
		"actual":        map[string]any{"tokens": orNot(s.ActualTokens), "minutes": orNot(s.ActualMinutes)},
		"gates":         map[string]any{"green": orNot(s.GatesGreen)},
		"human_touches": orNot(s.HumanTouches),
	}, "", "  ")
}

// Execute dispatches one build for r.First, opens one draft pull request, and returns the scorecard.
// With r.DryRun it dispatches and opens nothing and returns the plan.
func Execute(ctx context.Context, r Report, e Exec) (Result, error) {
	f := r.First
	if f == nil {
		return Result{}, errors.New("firstrun: no covered finding to fix")
	}
	if r.DryRun {
		return Result{Plan: fmt.Sprintf("Would dispatch one build for %s with pack %s, then open one draft pull request.", f.Finding.ID, f.Pack)}, nil
	}
	ticket := api.TicketID("first-run-" + f.Finding.ID)
	branch := e.Branch
	if branch == "" {
		branch = fmt.Sprintf("factory/%s-a1", ticket)
	}
	s, err := e.Dispatcher.Dispatch(ctx, api.Brief{
		Ticket: ticket, Attempt: 1, Name: string(ticket) + ".md", Text: briefText(*f), Repo: e.Repo, Base: e.Base,
		Branch: branch, Model: e.Model, Agent: e.Agent,
	})
	if err != nil {
		return Result{}, fmt.Errorf("firstrun: dispatch %s: %w", ticket, err)
	}
	pr, err := e.PRs.OpenDraft(ctx, branch, e.Base, "Fix "+f.Finding.Title, prBody(*f))
	if err != nil {
		return Result{}, fmt.Errorf("firstrun: open draft pull request: %w", err)
	}
	sc := Scorecard{Finding: f.Finding.ID, EstimateTokens: f.Tokens, EstimateMinutes: f.Minutes}
	if u, err := e.Dispatcher.Usage(ctx, s); err == nil {
		if n := u.InputTokens + u.OutputTokens + u.CacheReadTokens + u.CacheWriteTokens; n > 0 {
			sc.ActualTokens = &n
		}
		if m := int(u.WallTime.Minutes()); u.WallTime > 0 {
			sc.ActualMinutes = &m
		}
	}
	if e.Observer != nil {
		if o, err := e.Observer.Observe(ctx, ticket, 1); err == nil {
			sc.GatesGreen = o.ChecksGreen
		}
	}
	return Result{Session: s, PR: pr, Scorecard: sc}, nil
}

func briefText(f Row) string {
	return fmt.Sprintf("Fix the auditor finding %s (%s) using the %s pack. Keep the change small and run the repo's gate. "+
		"Verify the result in a fresh session before you push.\n", f.Finding.ID, loc(f.Finding), f.Pack)
}

// prBody names the finding and the pack. It carries no estimate, count or model.
func prBody(f Row) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Fixes the auditor finding `%s` (%s) with the %s pack.\n\nOpened by `factory first-run` as a draft for review.\n", f.Finding.ID, loc(f.Finding), f.Pack)
	return b.String()
}
