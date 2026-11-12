// Package reconcile is the orchestrator's brain: a pure Decide that turns the
// state and the observations into actions, and a Tick pass that applies them
// through the api ports. Completion is read from observations (branch, report
// and PR), never from session status.
package reconcile

import (
	"sort"
	"strconv"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/pick"
)

// SteerMessage is what a stalled session is told once.
const SteerMessage = "No push seen for a while. Commit and push what you have, then continue, or say what blocks you."

// Config holds the scheduler settings. Zero values take the defaults noted.
type Config struct {
	Tick            time.Duration // loop period (30s)
	StallAfter      time.Duration // no push for this long gives one Steer; twice gives Retry. 0 turns stall detection off
	MaxAttempts     int           // attempts before NeedsHuman (3)
	MaxConcurrent   int           // slots; 0 takes the dispatcher's cap
	Base            string        // base branch written into briefs (main)
	MaxRetryBackoff time.Duration // cap on the retry delay (5m)
}

func (c Config) withDefaults() Config {
	if c.Tick <= 0 {
		c.Tick = 30 * time.Second
	}
	if c.MaxAttempts <= 0 {
		c.MaxAttempts = 3
	}
	if c.MaxRetryBackoff <= 0 {
		c.MaxRetryBackoff = 5 * time.Minute
	}
	if c.Base == "" {
		c.Base = "main"
	}
	return c
}

// backoffCap is the wait before retrying after failed attempt n: min(10s*2^(n-1), limit) (Symphony 8.4).
func backoffCap(n int, limit time.Duration) time.Duration {
	d := 10 * time.Second
	for i := 1; i < n && d < limit; i++ {
		d *= 2
	}
	return min(d, limit)
}

// Entry is one claimed ticket.
type Entry struct {
	Ticket    api.Ticket
	Phase     api.Phase // running, stalled or retry
	Attempt   int
	Session   *api.Session // nil after a restart; the key is rebuilt from ticket and attempt
	StartedAt time.Time
	SteeredAt time.Time       // zero until a Steer was sent for the current stall
	RetryAt   time.Time       // when a retry-queued entry may be dispatched again
	Error     string          // why the entry is queued for retry
	LastObs   api.Observation // last observation that succeeded
}

// State is everything Decide reads besides observations and the clock.
type State struct {
	Entries         map[api.TicketID]Entry
	Ready           []api.Ticket // candidates from the tracker, already minus tracked ones or not
	Terminal        map[api.TicketID]bool
	CancelRequested map[api.TicketID]bool
	Locks           pick.Locks
	FiresLeft       int

	// Unobserved lists running tickets whose observation failed this tick; Decide makes no stall decision for them.
	Unobserved map[api.TicketID]bool

	fired      []time.Time // dispatch times in the last hour, kept by Tick
	noDispatch bool        // the tracker read failed this tick: reconcile only
}

// Kind names an action.
type Kind string

// The actions Decide can return.
const (
	Dispatch   Kind = "dispatch"
	Steer      Kind = "steer"
	Retry      Kind = "retry"
	Cancel     Kind = "cancel"
	MarkDone   Kind = "mark-done"
	NeedsHuman Kind = "needs-human"
	Requeue    Kind = "requeue" // a due retry found no free slot; Reason is the error to record
)

// Action is a plain value describing one thing to do. Attempt is the attempt
// the action is about; for Dispatch it is the attempt to start.
type Action struct {
	Kind    Kind
	ID      api.TicketID
	Ticket  api.Ticket // set for Dispatch
	Attempt int
	Message string    // set for Steer
	At      time.Time // set for Retry: when the next attempt may start
	Reason  string
}

func holdsSlot(p api.Phase) bool {
	return p == api.PhaseClaimed || p == api.PhaseRunning || p == api.PhaseStalled
}

// Decide follows Symphony 8.1: reconcile running entries (stall, terminal,
// done), check preflight, then dispatch due retries and new tickets while
// slots remain. It reads only its arguments.
func Decide(s State, obs []api.Observation, now time.Time, cfg Config) []Action {
	cfg = cfg.withDefaults()
	byID := map[api.TicketID]api.Observation{}
	for _, o := range obs {
		byID[o.Ticket] = o
	}
	ids := make([]api.TicketID, 0, len(s.Entries))
	for id := range s.Entries {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })

	var out []Action
	used := 0
	var due []Entry
	var running []api.Ticket
	for _, id := range ids {
		e := s.Entries[id]
		running = append(running, e.Ticket)
		if holdsSlot(e.Phase) {
			used++
		}
		switch {
		case s.CancelRequested[id]:
			out = append(out, Action{Kind: Cancel, ID: id, Attempt: e.Attempt, Reason: "canceled"})
		case s.Terminal[id]:
			out = append(out, Action{Kind: Cancel, ID: id, Attempt: e.Attempt, Reason: "terminal"})
		case e.Phase == api.PhaseRetryQueue:
			if !now.Before(e.RetryAt) {
				due = append(due, e)
			}
		case s.Unobserved[id]:
			// Symphony 8.5: a failed refresh keeps the worker running; decide nothing this tick.
		default:
			if a, ok := reconcileOne(e, byID[id], now, cfg); ok {
				out = append(out, a)
			}
		}
	}

	if cfg.MaxConcurrent <= 0 || s.noDispatch {
		return out
	}
	free := cfg.MaxConcurrent - used
	fires := s.FiresLeft
	sort.SliceStable(due, func(i, j int) bool { return due[i].RetryAt.Before(due[j].RetryAt) })
	for _, e := range due {
		if free <= 0 {
			if e.Error != SlotsExhausted {
				out = append(out, Action{Kind: Requeue, ID: e.Ticket.ID, Attempt: e.Attempt, Reason: SlotsExhausted})
			}
			continue
		}
		if fires <= 0 {
			break
		}
		out = append(out, Action{Kind: Dispatch, ID: e.Ticket.ID, Ticket: e.Ticket, Attempt: e.Attempt + 1})
		free--
		fires--
	}
	var ranked []api.Ticket
	for _, t := range s.Ready {
		if _, tracked := s.Entries[t.ID]; !tracked {
			ranked = append(ranked, t)
		}
	}
	for _, t := range pick.Refill(free, pick.Rank(ranked), running, s.Locks, fires) {
		out = append(out, Action{Kind: Dispatch, ID: t.ID, Ticket: t, Attempt: 1})
	}
	return out
}

func reconcileOne(e Entry, o api.Observation, now time.Time, cfg Config) (Action, bool) {
	id := e.Ticket.ID
	since := e.StartedAt
	if o.Attempt == e.Attempt {
		if o.Branch != "" && o.HasReport && o.PR > 0 {
			return Action{Kind: MarkDone, ID: id, Attempt: e.Attempt}, true
		}
		if o.LastPush.After(since) {
			since = o.LastPush
		}
	}
	if cfg.StallAfter <= 0 {
		return Action{}, false
	}
	elapsed := now.Sub(since)
	switch {
	case elapsed >= 2*cfg.StallAfter:
		if e.Attempt >= cfg.MaxAttempts {
			return Action{Kind: NeedsHuman, ID: id, Attempt: e.Attempt, Reason: "stalled after " + strconv.Itoa(e.Attempt) + " attempts"}, true
		}
		return Action{Kind: Retry, ID: id, Attempt: e.Attempt, At: now.Add(cfg.backoff(e.Attempt)), Reason: "stalled"}, true
	case elapsed >= cfg.StallAfter && e.SteeredAt.Before(since):
		return Action{Kind: Steer, ID: id, Attempt: e.Attempt, Message: SteerMessage}, true
	}
	return Action{}, false
}

// SlotsExhausted is the error recorded on a retry that found no free slot (Symphony 8.4).
const SlotsExhausted = "no available orchestrator slots"

func (c Config) backoff(n int) time.Duration { return backoffCap(n, c.MaxRetryBackoff) }
