// Ported from browser-use/browser-use@dfb6a73 browser_use/ax.py
package browsercheck

import (
	"context"
	"sync"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
)

// Conditions picks which signals Settle waits for.
type Conditions struct {
	Ready   bool // document is not loading
	Quiet   bool // no DOM mutation or input event for the quiet window
	Network bool // no fresh in-flight request and none finished within the quiet window
}

// SettleResult says why a Settle call returned and how long it took.
type SettleResult struct {
	Why  string // "quiet" when every chosen condition held, "cap" when the cap ran out
	Took time.Duration
}

// probeState is what one look at the page reports.
type probeState struct {
	Loading bool
	Idle    time.Duration // time since the last DOM mutation or input event
}

// settleEnv is the page and the clock Settle reads; tests swap in a fake clock.
type settleEnv interface {
	now() time.Duration
	wait(time.Duration)
	probeDoc() (probeState, error)
	network() (pending int, sinceLast time.Duration)
}

const (
	navCap      = 5 * time.Second         // the longest wait while the document is still loading
	staleReq    = 1500 * time.Millisecond // an older in-flight request is a long poll, not pending
	probeEvery  = 20 * time.Millisecond
	loadingPoll = 40 * time.Millisecond
)

// Settle waits on events, never a fixed sleep: the chosen conditions must hold, bounded by cap.
// While the document loads the bound grows to navCap. since is when the action began, so DOM
// quiet from before it does not count; zero means now.
func Settle(env settleEnv, c Conditions, cap, quiet, since time.Duration) SettleResult {
	start := env.now()
	if since == 0 || since > start {
		since = start
	}
	limit := cap
	for env.now()-start < limit {
		p, err := env.probeDoc()
		switch {
		case err != nil:
			p = probeState{Loading: true} // a navigation is replacing the document; look again
		case p.Loading && limit < navCap:
			limit = navCap
		}
		p.Idle = min(p.Idle, env.now()-since)
		if (!c.Ready || !p.Loading) && (!c.Quiet || p.Idle >= quiet) && (!c.Network || !netBusy(env, quiet)) {
			return SettleResult{"quiet", env.now() - start}
		}
		d := loadingPoll
		if !p.Loading && c.Quiet && p.Idle < quiet {
			d = max(probeEvery, quiet-p.Idle)
		}
		env.wait(d)
	}
	return SettleResult{"cap", env.now() - start}
}

func netBusy(env settleEnv, quiet time.Duration) bool {
	pending, since := env.network()
	return pending > 0 || since < quiet
}

// netTracker counts requests the page has started and not finished.
type netTracker struct {
	mu       sync.Mutex
	inflight map[string]time.Duration // request id to start time
	last     time.Duration
	seen     bool
}

func (n *netTracker) start(id string, at time.Duration) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.inflight[id], n.last, n.seen = at, at, true
}

func (n *netTracker) done(id string, at time.Duration) {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.inflight, id)
	n.last, n.seen = at, true
}

// snapshot returns the fresh in-flight count and the time since the last network event.
func (n *netTracker) snapshot(at time.Duration) (int, time.Duration) {
	n.mu.Lock()
	defer n.mu.Unlock()
	pending := 0
	for _, t := range n.inflight {
		if at-t < staleReq {
			pending++
		}
	}
	if !n.seen {
		return pending, time.Hour
	}
	return pending, at - n.last
}

// probeJS reports document readiness and the time since the page last changed. The observer is
// installed on first call and survives until the document is replaced.
const probeJS = `(() => {
  const w = window;
  if (!w.__fcObs) {
    w.__fcObs = true;
    w.__fcLast = performance.now();
    const bump = () => { w.__fcLast = performance.now(); };
    new MutationObserver(bump).observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
    for (const t of ['input', 'change']) w.addEventListener(t, bump, true);
  }
  return {loading: document.readyState === 'loading', idle: performance.now() - w.__fcLast};
})()`

type probeReply struct {
	Loading bool    `json:"loading"`
	Idle    float64 `json:"idle"`
}

// pageEnv is the live settleEnv over a chromedp context.
type pageEnv struct {
	ctx   context.Context
	t0    time.Time
	track *netTracker
}

// newPageEnv turns on network events for ctx and starts counting requests.
func newPageEnv(ctx context.Context) (*pageEnv, error) {
	e := &pageEnv{ctx: ctx, t0: time.Now(), track: &netTracker{inflight: map[string]time.Duration{}}}
	if err := chromedp.Listen(ctx, func(ev any) {
		switch v := ev.(type) {
		case *network.EventRequestWillBeSent:
			e.track.start(string(v.RequestID), e.now())
		case *network.EventLoadingFinished:
			e.track.done(string(v.RequestID), e.now())
		case *network.EventLoadingFailed:
			e.track.done(string(v.RequestID), e.now())
		}
	}); err != nil {
		return nil, err
	}
	_, err := chromedp.Run(ctx, func(ctx context.Context, t *chromedp.Target) (chromedp.Void, error) {
		_, err := cdp.Call(ctx, t, network.Enable, network.EnableParams{})
		return chromedp.Void{}, err
	})
	return e, err
}

func (e *pageEnv) now() time.Duration { return time.Since(e.t0) }

func (e *pageEnv) wait(d time.Duration) {
	select {
	case <-time.After(d):
	case <-e.ctx.Done():
	}
}

func (e *pageEnv) probeDoc() (probeState, error) {
	r, err := chromedp.Run(e.ctx, chromedp.Evaluate[probeReply](probeJS))
	if err != nil {
		return probeState{}, err
	}
	return probeState{Loading: r.Loading, Idle: time.Duration(r.Idle * float64(time.Millisecond))}, nil
}

func (e *pageEnv) network() (int, time.Duration) { return e.track.snapshot(e.now()) }
