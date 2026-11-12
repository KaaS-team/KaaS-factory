package mergeq

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"time"
)

// ErrConflict is returned by Git.Merge when the heads do not merge cleanly onto the base.
var ErrConflict = errors.New("mergeq: merge conflict")

// ErrBaseMoved is returned by Git.FastForward when the base is no longer the ref's parent.
var ErrBaseMoved = errors.New("mergeq: base moved")

// Merged is a temp ref holding heads merged onto Base.
type Merged struct {
	Ref  string
	Base string
}

// Git is the repository access Run needs.
type Git interface {
	// Base returns the current base commit.
	Base(ctx context.Context) (string, error)
	// Merge merges heads, in order, onto the base into a new temp ref.
	Merge(ctx context.Context, heads []string) (Merged, error)
	// FastForward moves the base to ref, or returns ErrBaseMoved.
	FastForward(ctx context.Context, ref string) error
}

// Verdict is a gate outcome.
type Verdict struct {
	Pass    bool
	LogTail string
}

// Gate runs the repo gate on a ref.
type Gate interface {
	Run(ctx context.Context, ref string) (Verdict, error)
}

// Store is the durable queue and PR state, kept by the tracker.
type Store interface {
	// Queued returns the queued PRs in order.
	Queued(ctx context.Context) ([]Entry, error)
	// PR returns the live state of one PR.
	PR(ctx context.Context, id string) (PRState, error)
	// Landed records that the PRs were merged.
	Landed(ctx context.Context, ids []string) error
	// Eject removes a PR from the queue and records the failing gate log tail.
	Eject(ctx context.Context, id, logTail string) error
	// Drop removes a PR that closed or merged.
	Drop(ctx context.Context, id, reason string) error
	// Requeue records the new head of a PR that moved after it was queued.
	Requeue(ctx context.Context, id, head string) error
}

// Ejection is a PR the queue removed because it breaks the gate.
type Ejection struct {
	ID      string
	LogTail string
}

// Report is what one Run did.
type Report struct {
	Landed   []string
	Ejected  []Ejection
	Dropped  []string
	Returned []string // PRs the precheck sent back to their agent
	GateRuns int
}

// Config holds the queue settings.
type Config struct {
	BatchSize      int           // PRs tested together; DefaultBatchSize when not positive
	BatchTimeout   time.Duration // a gate run longer than this counts as a red result; no limit when zero
	PushBackoff    time.Duration // first wait after a push that was not a fast-forward; no wait when zero
	PushBackoffMax time.Duration // cap on that wait
	PushAttempts   int           // pushes of one batch that may be rejected as not a fast-forward before it is parked as failed; DefaultPushAttempts when not positive
}

// DefaultPushAttempts is Config.PushAttempts when it is not positive.
const DefaultPushAttempts = 5

// Runner applies Plan through its interfaces.
type Runner struct {
	Git   Git
	Gate  Gate
	Store Store
	Cfg   Config
	Sleep func(ctx context.Context, d time.Duration) error // waits between push retries; real time when nil
	Pre   *Precheck                                        // optional; nil skips the stale-diff and syntax precheck
}

// Run plans and applies actions until the queue has nothing left to do or ctx ends. The base only
// advances to a ref whose gate passed on exactly the heads being landed.
func (r *Runner) Run(ctx context.Context) (Report, error) {
	var rep Report
	pushRetries := 0
	results := map[string]Result{}
	for {
		if err := ctx.Err(); err != nil {
			return rep, err
		}
		queue, err := r.Store.Queued(ctx)
		if err != nil {
			return rep, fmt.Errorf("queued: %w", err)
		}
		st := State{BatchSize: r.Cfg.BatchSize, PRs: map[string]PRState{}, Results: results}
		if st.Base, err = r.Git.Base(ctx); err != nil {
			return rep, fmt.Errorf("base: %w", err)
		}
		for _, e := range queue {
			if st.PRs[e.ID], err = r.Store.PR(ctx, e.ID); err != nil {
				return rep, fmt.Errorf("pr %s: %w", e.ID, err)
			}
		}
		if queue, err = r.precheck(ctx, queue, st, &rep); err != nil {
			return rep, err
		}
		actions := Plan(queue, st)
		if len(actions) == 0 {
			return rep, nil
		}
		for _, a := range actions {
			if results, err = r.apply(ctx, a, st, results, &rep, &pushRetries); err != nil {
				return rep, err
			}
		}
	}
}

// precheck sends PRs that no longer apply to the base back to their agent and returns the rest. Only
// PRs that are still open at their queued head are checked; Plan handles the others.
func (r *Runner) precheck(ctx context.Context, queue []Entry, st State, rep *Report) ([]Entry, error) {
	if r.Pre == nil || len(queue) == 0 {
		return queue, nil
	}
	var live, rest []Entry
	for _, e := range queue {
		if p := st.PRs[e.ID]; p.Open && !p.Merged && p.Head == e.Head {
			live = append(live, e)
		} else {
			rest = append(rest, e)
		}
	}
	ok, bad, err := r.Pre.Filter(ctx, st.Base, live)
	if err != nil {
		return nil, err
	}
	for _, f := range bad {
		if err := r.Pre.Return(ctx, f); err != nil {
			return nil, fmt.Errorf("return %s: %w", f.ID, err)
		}
		rep.Returned = append(rep.Returned, f.ID)
	}
	keep := map[string]bool{}
	for _, e := range ok {
		keep[e.ID] = true
	}
	for _, e := range rest {
		keep[e.ID] = true
	}
	var out []Entry
	for _, e := range queue {
		if keep[e.ID] {
			out = append(out, e)
		}
	}
	return out, nil
}

func (r *Runner) apply(ctx context.Context, a Action, st State, results map[string]Result, rep *Report, pushRetries *int) (map[string]Result, error) {
	switch a.Kind {
	case KindDrop:
		rep.Dropped = append(rep.Dropped, a.ID)
		return results, r.Store.Drop(ctx, a.ID, a.Reason)
	case KindRequeue:
		return results, r.Store.Requeue(ctx, a.ID, a.Head)
	case KindEject:
		rep.Ejected = append(rep.Ejected, Ejection{ID: a.ID, LogTail: a.Log})
		return results, r.Store.Eject(ctx, a.ID, a.Log)
	case KindTest:
		res, err := r.test(ctx, a, rep)
		if err != nil {
			return results, err
		}
		next := make(map[string]Result, len(results)+1)
		for k, v := range results {
			next[k] = v
		}
		next[Key(a.IDs, a.Heads)] = res
		return next, nil
	case KindLand:
		return r.land(ctx, a, st, results, rep, pushRetries)
	}
	return results, fmt.Errorf("mergeq: unknown action %q", a.Kind)
}

func (r *Runner) test(ctx context.Context, a Action, rep *Report) (Result, error) {
	res := Result{IDs: a.IDs, Heads: a.Heads}
	m, err := r.Git.Merge(ctx, a.Heads)
	if errors.Is(err, ErrConflict) {
		res.Log = err.Error()
		return res, nil
	}
	if err != nil {
		return res, fmt.Errorf("merge: %w", err)
	}
	res.Base, res.Ref = m.Base, m.Ref
	gctx := ctx
	if r.Cfg.BatchTimeout > 0 {
		var cancel context.CancelFunc
		gctx, cancel = context.WithTimeout(ctx, r.Cfg.BatchTimeout)
		defer cancel()
	}
	v, err := r.Gate.Run(gctx, m.Ref)
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil && gctx.Err() != nil {
		rep.GateRuns++
		res.Log = TimeoutLog // a timeout is a red result, split like a CI failure
		return res, nil
	}
	if err != nil {
		return res, fmt.Errorf("gate: %w", err)
	}
	rep.GateRuns++
	res.Pass, res.Log = v.Pass, v.LogTail
	return res, nil
}

func (r *Runner) land(ctx context.Context, a Action, st State, results map[string]Result, rep *Report, pushRetries *int) (map[string]Result, error) {
	// A head that moved since the plan was made invalidates the green result: plan again.
	for i, id := range a.IDs {
		p, err := r.Store.PR(ctx, id)
		if err != nil {
			return results, fmt.Errorf("pr %s: %w", id, err)
		}
		if !p.Open || p.Merged || p.Head != a.Heads[i] {
			return results, nil
		}
	}
	if err := r.Git.FastForward(ctx, a.Ref); err != nil {
		if PushOutcome(err) == OutcomeRetryBatch {
			// The gate passed, so the whole batch is tested again on the new base, without a bisect.
			*pushRetries++
			if limit := cmp.Or(max(r.Cfg.PushAttempts, 0), DefaultPushAttempts); *pushRetries >= limit {
				// Never a fast-forward: park the batch as failed, with the reason, instead of testing it forever.
				reason := fmt.Sprintf("mergeq: push was not a fast-forward in %d attempts: %v", *pushRetries, err)
				*pushRetries = 0
				for _, id := range a.IDs {
					rep.Ejected = append(rep.Ejected, Ejection{ID: id, LogTail: reason})
					if err := r.Store.Eject(ctx, id, reason); err != nil {
						return results, fmt.Errorf("eject %s: %w", id, err)
					}
				}
				return results, nil
			}
			wait := Backoff(*pushRetries-1, r.Cfg.PushBackoff, r.Cfg.PushBackoffMax)
			if wait > 0 {
				sl := r.Sleep
				if sl == nil {
					sl = sleep
				}
				if err := sl(ctx, wait); err != nil {
					return results, err
				}
			}
			return results, nil
		}
		return results, fmt.Errorf("fast-forward: %w", err)
	}
	*pushRetries = 0
	rep.Landed = append(rep.Landed, a.IDs...)
	if err := r.Store.Landed(ctx, a.IDs); err != nil {
		return results, fmt.Errorf("landed: %w", err)
	}
	return AfterLand(results, a.IDs, a.Heads), nil
}
