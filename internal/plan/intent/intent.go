// Package intent turns a goal into a spec and then into planned tickets. The model sits behind
// Drafter; every answer is checked here and rejected when it has a problem. Port of src/intent/.
package intent

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/KaaS-team/factory/internal/plan"
)

// Spec is a drafted spec: a file stem like "01-resume" and markdown with one "AC-n: text" line per criterion.
type Spec struct {
	Slug     string
	Markdown string
}

// Draft is one drafted ticket: the drafter's own handle, a title and a planned body v1.
type Draft struct {
	Key   string
	Title string
	Body  string
}

// Drafter is the model-backed author of specs and tickets.
type Drafter interface {
	// Spec drafts a spec for the goal.
	Spec(ctx context.Context, goal string) (Spec, error)
	// Tickets splits a checked spec into drafted tickets.
	Tickets(ctx context.Context, spec Spec) ([]Draft, error)
}

// Result is a goal that passed every check: the spec, the validated plan and its waves.
type Result struct {
	Spec  Spec
	Plan  plan.Plan
	Waves [][]string
}

// ProblemsError reports why a draft was rejected; Stage is "spec" or "tickets".
type ProblemsError struct {
	Stage    string
	Problems []string
}

// Error joins the problems into one line.
func (e *ProblemsError) Error() string {
	return e.Stage + ": " + strings.Join(e.Problems, "; ")
}

var (
	slugRe = regexp.MustCompile(`^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$`)
	// Same pattern as the kit's check-acceptance.py, so a criterion found here is one that script holds.
	acRe = regexp.MustCompile(`(?m)^\s*(?:[-*]\s+)?(?:\*\*)?(AC-\d+)(?:\*\*)?\s*[:.]\s*(.+?)\s*$`)
)

// SpecProblems lists every way a draft is not a spec; criteria must be AC-1, AC-2, ... in order, once each.
func SpecProblems(s Spec) []string {
	var out []string
	if !slugRe.MatchString(s.Slug) {
		out = append(out, fmt.Sprintf("slug %q is not NN-words-with-dashes", s.Slug))
	}
	acs := acRe.FindAllStringSubmatch(s.Markdown, -1)
	if len(acs) == 0 {
		out = append(out, "the spec has no acceptance criteria (AC-1: ...)")
	}
	seen := map[string]bool{}
	for i, m := range acs {
		switch {
		case seen[m[1]]:
			out = append(out, m[1]+" is defined twice")
		case m[1] != fmt.Sprintf("AC-%d", i+1):
			out = append(out, fmt.Sprintf("%s is out of order: expected AC-%d", m[1], i+1))
		}
		seen[m[1]] = true
	}
	return out
}

// Run drafts a spec and tickets for goal. It returns a *ProblemsError when either draft has a problem,
// and the drafter's own error unchanged.
func Run(ctx context.Context, d Drafter, goal string) (Result, error) {
	if strings.TrimSpace(goal) == "" {
		return Result{}, &ProblemsError{Stage: "spec", Problems: []string{"the intent is empty"}}
	}
	spec, err := d.Spec(ctx, goal)
	if err != nil {
		return Result{}, err
	}
	if p := SpecProblems(spec); len(p) > 0 {
		return Result{}, &ProblemsError{Stage: "spec", Problems: p}
	}
	drafts, err := d.Tickets(ctx, spec)
	if err != nil {
		return Result{}, err
	}
	var problems []string
	p := plan.Plan{}
	for _, dr := range drafts {
		t, err := plan.NewTicket(dr.Key, dr.Title, dr.Body)
		if err != nil {
			problems = append(problems, fmt.Sprintf("ticket %s: %s", dr.Key, err))
			continue
		}
		p.Tickets = append(p.Tickets, t)
	}
	problems = append(problems, p.Problems()...)
	if len(problems) > 0 {
		return Result{}, &ProblemsError{Stage: "tickets", Problems: problems}
	}
	waves, err := p.Waves()
	if err != nil {
		return Result{}, &ProblemsError{Stage: "tickets", Problems: []string{err.Error()}}
	}
	return Result{Spec: spec, Plan: p, Waves: waves}, nil
}
