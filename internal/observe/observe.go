// Package observe reads git and the tracker to describe one ticket's run.
package observe

import (
	"context"
	"fmt"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// Checks is the rolled-up state of a pull request's checks.
type Checks int

// The states a check roll-up can be in.
const (
	ChecksNone    Checks = iota // no checks exist
	ChecksPending               // some check has not finished
	ChecksGreen                 // every check passed
	ChecksRed                   // some check failed
)

// PR is a pull request whose head is a work branch.
type PR struct {
	Number int
	Open   bool
}

// Source is the narrow view of GitHub and git that Observer needs.
type Source interface {
	// Branch reports whether the branch exists and when it was last pushed.
	Branch(ctx context.Context, name string) (lastPush time.Time, exists bool, err error)
	// PullRequest finds the newest pull request with the given head branch.
	PullRequest(ctx context.Context, head string) (pr PR, found bool, err error)
	// Checks rolls up the checks of a pull request.
	Checks(ctx context.Context, pr int) (Checks, error)
	// DiffFiles lists the files the branch changes against its base.
	DiffFiles(ctx context.Context, branch string) ([]string, error)
}

// Observer implements api.Observer on top of a Source.
type Observer struct{ src Source }

// New returns an Observer reading from src.
func New(src Source) *Observer { return &Observer{src: src} }

// WorkBranch is the branch a session pushes for one attempt.
func WorkBranch(id api.TicketID, attempt int) string {
	return fmt.Sprintf("factory/%s-a%d", id, attempt)
}

// ReportBranch is the branch a session pushes its report to.
func ReportBranch(id api.TicketID) string { return "report/" + string(id) }

// Observe describes the ticket's attempt from the work branch, the report branch, the PR and its checks.
func (o *Observer) Observe(ctx context.Context, id api.TicketID, attempt int) (api.Observation, error) {
	obs := api.Observation{Ticket: id, Attempt: attempt}
	_, hasReport, err := o.src.Branch(ctx, ReportBranch(id))
	if err != nil {
		return obs, fmt.Errorf("report branch: %w", err)
	}
	obs.HasReport = hasReport

	branch := WorkBranch(id, attempt)
	push, exists, err := o.src.Branch(ctx, branch)
	if err != nil {
		return obs, fmt.Errorf("work branch: %w", err)
	}
	if !exists {
		return obs, nil
	}
	obs.Branch, obs.LastPush = branch, push

	if obs.DiffFiles, err = o.src.DiffFiles(ctx, branch); err != nil {
		return obs, fmt.Errorf("diff: %w", err)
	}
	pr, found, err := o.src.PullRequest(ctx, branch)
	if err != nil {
		return obs, fmt.Errorf("pull request: %w", err)
	}
	if !found || !pr.Open {
		return obs, nil
	}
	obs.PR = pr.Number
	state, err := o.src.Checks(ctx, pr.Number)
	if err != nil {
		return obs, fmt.Errorf("checks: %w", err)
	}
	switch state {
	case ChecksGreen:
		t := true
		obs.ChecksGreen = &t
	case ChecksRed:
		f := false
		obs.ChecksGreen = &f
	case ChecksNone, ChecksPending:
		// nil means pending or none
	}
	return obs, nil
}

// PhaseOf maps an observation to the phase it proves: no push is ready, a push is running,
// and a report plus an open PR is done.
func PhaseOf(o api.Observation) api.Phase {
	switch {
	case o.Branch == "":
		return api.PhaseReady
	case o.HasReport && o.PR > 0:
		return api.PhaseDone
	default:
		return api.PhaseRunning
	}
}
