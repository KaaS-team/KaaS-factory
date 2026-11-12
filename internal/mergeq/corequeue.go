package mergeq

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"sync"

	"github.com/KaaS-team/factory/internal/api"
)

// Tracker is the tracker access CoreQueue needs: the api.Tracker writes plus two reads.
type Tracker interface {
	Comment(ctx context.Context, id api.TicketID, body string) error
	SetPhase(ctx context.Context, id api.TicketID, p api.Phase) error
	// InPhase lists the tickets in phase p, in the order they entered it.
	InPhase(ctx context.Context, p api.Phase) ([]api.TicketID, error)
	// Comments returns the ticket's comment bodies, oldest first.
	Comments(ctx context.Context, id api.TicketID) ([]string, error)
}

// Heads reads live pull request state by number.
type Heads interface {
	PR(ctx context.Context, pr int) (PRState, error)
}

// Deps are what NewCoreQueue needs. Queue state lives in Tracker; nothing is kept in memory.
type Deps struct {
	Tracker Tracker
	Git     Git
	Gate    Gate
	Heads   Heads
	Cfg     Config
	Applier Applier // optional; when set, a PR that no longer applies to the base goes back to its agent
	Syntax  Syntax  // optional; needs Paths too
	Paths   func(ctx context.Context, id, head string) ([]string, error)
}

// CoreQueue is the merge queue the core loop feeds: a Runner over tracker-held queue state.
type CoreQueue struct {
	d  Deps
	mu sync.Mutex // one Run at a time
}

// NewCoreQueue returns a queue over d.
func NewCoreQueue(d Deps) *CoreQueue { return &CoreQueue{d: d} }

// queuedMarker is the comment marker that records a queued PR number and its head.
type marker struct {
	PR   int    `json:"pr"`
	Head string `json:"head"`
}

var markerRE = regexp.MustCompile(`<!-- factory:queued (\{.*?\}) -->`)

func queuedMarker(pr int, head string) string {
	b, _ := json.Marshal(marker{PR: pr, Head: head})
	return "<!-- factory:queued " + string(b) + " -->"
}

func parseQueuedMarker(body string) (marker, bool) {
	var found marker
	ok := false
	for _, m := range markerRE.FindAllStringSubmatch(body, -1) {
		var x marker
		if json.Unmarshal([]byte(m[1]), &x) == nil && x.PR > 0 {
			found, ok = x, true
		}
	}
	return found, ok
}

// latestMarker returns the newest queued marker on the ticket.
func (q *CoreQueue) latestMarker(ctx context.Context, id api.TicketID) (marker, error) {
	bodies, err := q.d.Tracker.Comments(ctx, id)
	if err != nil {
		return marker{}, fmt.Errorf("comments %s: %w", id, err)
	}
	var out marker
	found := false
	for _, b := range bodies {
		if m, ok := parseQueuedMarker(b); ok {
			out, found = m, true
		}
	}
	if !found {
		return marker{}, fmt.Errorf("mergeq: ticket %s is queued but has no queue marker", id)
	}
	return out, nil
}

// Enqueue records the PR number and its current head on the ticket and moves it to the queued phase.
// A ticket that is already queued is left as it is.
func (q *CoreQueue) Enqueue(ctx context.Context, id api.TicketID, pr int) error {
	in, err := q.d.Tracker.InPhase(ctx, api.PhaseQueued)
	if err != nil {
		return fmt.Errorf("queued tickets: %w", err)
	}
	for _, x := range in {
		if x == id {
			return nil
		}
	}
	st, err := q.d.Heads.PR(ctx, pr)
	if err != nil {
		return fmt.Errorf("pr %d: %w", pr, err)
	}
	if err := q.d.Tracker.Comment(ctx, id, "Queued for merge as PR #"+strconv.Itoa(pr)+".\n\n"+queuedMarker(pr, st.Head)); err != nil {
		return err
	}
	return q.d.Tracker.SetPhase(ctx, id, api.PhaseQueued)
}

// Queued returns the queued tickets in enqueue order, rebuilt from the tracker.
func (q *CoreQueue) Queued(ctx context.Context) ([]Entry, error) {
	in, err := q.d.Tracker.InPhase(ctx, api.PhaseQueued)
	if err != nil {
		return nil, fmt.Errorf("queued tickets: %w", err)
	}
	out := make([]Entry, 0, len(in))
	for _, id := range in {
		m, err := q.latestMarker(ctx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, Entry{ID: string(id), Head: m.Head})
	}
	return out, nil
}

// Run takes the queued entries in order and runs one Runner pass. Landed tickets become merged,
// ejected ones needs-human with the gate log tail in a comment.
func (q *CoreQueue) Run(ctx context.Context) (Report, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	r := &Runner{Git: q.d.Git, Gate: q.d.Gate, Store: coreStore{q}, Cfg: q.d.Cfg}
	if q.d.Applier != nil {
		r.Pre = &Precheck{Applier: q.d.Applier, Syntax: q.d.Syntax, Paths: q.d.Paths, Return: q.returnToAgent}
	}
	return r.Run(ctx)
}

// returnToAgent comments the failing path on the ticket and puts it back in the running phase, so the
// agent fixes it and the PR is queued again; the ticket leaves the merge queue.
func (q *CoreQueue) returnToAgent(ctx context.Context, f Failure) error {
	tid := api.TicketID(f.ID)
	if err := q.d.Tracker.Comment(ctx, tid, "Returned to the agent: the PR "+f.Reason+". Failing path: `"+f.Path+"`."); err != nil {
		return err
	}
	return q.d.Tracker.SetPhase(ctx, tid, api.PhaseRunning)
}

// coreStore is the Runner's Store over the tracker.
type coreStore struct{ q *CoreQueue }

func (s coreStore) Queued(ctx context.Context) ([]Entry, error) { return s.q.Queued(ctx) }

func (s coreStore) PR(ctx context.Context, id string) (PRState, error) {
	m, err := s.q.latestMarker(ctx, api.TicketID(id))
	if err != nil {
		return PRState{}, err
	}
	return s.q.d.Heads.PR(ctx, m.PR)
}

func (s coreStore) Landed(ctx context.Context, ids []string) error {
	for _, id := range ids {
		if err := s.q.d.Tracker.SetPhase(ctx, api.TicketID(id), api.PhaseMerged); err != nil {
			return err
		}
	}
	return nil
}

func (s coreStore) Eject(ctx context.Context, id, logTail string) error {
	tid := api.TicketID(id)
	if err := s.q.d.Tracker.Comment(ctx, tid, "Needs a human: the merge queue ejected this PR because the gate fails with it.\n\n```\n"+logTail+"\n```"); err != nil {
		return err
	}
	return s.q.d.Tracker.SetPhase(ctx, tid, api.PhaseNeedsHuman)
}

func (s coreStore) Drop(ctx context.Context, id, reason string) error {
	p := api.PhaseCanceled
	if reason == ReasonMerged {
		p = api.PhaseMerged
	}
	return s.q.d.Tracker.SetPhase(ctx, api.TicketID(id), p)
}

// Requeue records the PR's new head; the newest marker wins and the queue position is kept.
func (s coreStore) Requeue(ctx context.Context, id, head string) error {
	m, err := s.q.latestMarker(ctx, api.TicketID(id))
	if err != nil {
		return err
	}
	return s.q.d.Tracker.Comment(ctx, api.TicketID(id), "The PR moved; queued again at its new head.\n\n"+queuedMarker(m.PR, head))
}
