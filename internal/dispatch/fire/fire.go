// Package fire is an api.Dispatcher that starts a session through a routine's
// documented fire endpoint, and the rate limiter that keeps it inside the
// per-routine and per-account hourly caps.
//
// The reply shape below is this package's assumption; it is not confirmed
// against the live API. The fire API cannot steer, cancel or report usage.
package fire

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/dispatch/brief"
)

// The documented limits.
const (
	PerRoutinePerHour = 30
	PerAccountPerHour = 100
	window            = time.Hour
)

// Scope says which cap a refused fire hit.
type Scope string

// The two caps.
const (
	ScopeRoutine Scope = "routine"
	ScopeAccount Scope = "account"
)

// ErrRateLimited matches every *RateError under errors.Is.
var ErrRateLimited = errors.New("fire: rate limited")

// ErrUnsupported is returned for what the fire API cannot do.
var ErrUnsupported = errors.New("fire: not supported by the fire endpoint")

// RateError is a fire refused by the limiter. No HTTP call was made.
type RateError struct {
	Scope   Scope
	RetryAt time.Time
}

func (e *RateError) Error() string {
	return fmt.Sprintf("fire: %s limit reached, next slot at %s", e.Scope, e.RetryAt.UTC().Format(time.RFC3339))
}

// Is reports whether target is ErrRateLimited.
func (e *RateError) Is(target error) bool { return target == ErrRateLimited }

// Limiter counts fires in a sliding hour per routine and for the account. It
// is safe for concurrent use and is shared by every Dispatcher of one account.
type Limiter struct {
	now func() time.Time

	mu      sync.Mutex
	routine map[string][]time.Time
	account []time.Time
}

// NewLimiter returns a Limiter that reads time from now.
func NewLimiter(now func() time.Time) *Limiter {
	return &Limiter{now: now, routine: map[string][]time.Time{}}
}

func prune(ts []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(ts) && !ts[i].After(cutoff) {
		i++
	}
	return ts[i:]
}

// Reserve counts one fire for routine, or returns a *RateError and counts
// nothing. A fire leaves the window exactly one hour after it was made.
func (l *Limiter) Reserve(routine string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.prune(routine, now)
	if r := l.routine[routine]; len(r) >= PerRoutinePerHour {
		return &RateError{Scope: ScopeRoutine, RetryAt: r[0].Add(window)}
	}
	if len(l.account) >= PerAccountPerHour {
		return &RateError{Scope: ScopeAccount, RetryAt: l.account[0].Add(window)}
	}
	l.routine[routine] = append(l.routine[routine], now)
	l.account = append(l.account, now)
	return nil
}

func (l *Limiter) prune(routine string, now time.Time) {
	cutoff := now.Add(-window)
	l.account = prune(l.account, cutoff)
	l.routine[routine] = prune(l.routine[routine], cutoff)
}

// Left is how many more fires routine may make now: the smaller of its own
// and the account's remaining count.
func (l *Limiter) Left(routine string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(routine, l.now())
	return max(0, min(PerRoutinePerHour-len(l.routine[routine]), PerAccountPerHour-len(l.account)))
}

// Config holds what the caller injects.
type Config struct {
	BaseURL       string
	Token         string
	Routine       string
	Limiter       *Limiter
	HTTP          *http.Client
	MaxConcurrent int
	Now           func() time.Time
}

// Dispatcher implements api.Dispatcher over the fire endpoint.
type Dispatcher struct {
	cfg  Config
	http *http.Client

	mu    sync.Mutex
	fired map[string]api.Session
}

// New checks cfg and returns a Dispatcher. Dispatchers for routines of one
// account must share one Limiter.
func New(cfg Config) (*Dispatcher, error) {
	if cfg.BaseURL == "" || cfg.Token == "" || cfg.Routine == "" || cfg.Limiter == nil {
		return nil, errors.New("fire: base URL, token, routine and limiter are required")
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.MaxConcurrent <= 0 {
		cfg.MaxConcurrent = 10
	}
	h := cfg.HTTP
	if h == nil {
		h = &http.Client{Timeout: 30 * time.Second}
	}
	return &Dispatcher{cfg: cfg, http: h, fired: map[string]api.Session{}}, nil
}

// Name returns "fire".
func (d *Dispatcher) Name() string { return "fire" }

// Caps reports a remote dispatcher limited to 30 fires an hour.
func (d *Dispatcher) Caps() api.Caps {
	return api.Caps{MaxConcurrent: d.cfg.MaxConcurrent, FiresPerHour: PerRoutinePerHour, Remote: true}
}

// Dispatch fires the routine with the brief's file name as the text. A key
// already fired by this process returns its session without another fire. A
// fire over either cap returns a *RateError without any HTTP call.
func (d *Dispatcher) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	name, err := brief.Name(b.Ticket, b.Attempt)
	if err != nil {
		return api.Session{}, err
	}
	if b.Name != name {
		return api.Session{}, fmt.Errorf("fire: brief is named %q, want %q", b.Name, name)
	}
	key := fmt.Sprintf("factory-%s-a%d", b.Ticket, b.Attempt)
	d.mu.Lock()
	defer d.mu.Unlock()
	if s, ok := d.fired[key]; ok {
		return s, nil
	}
	if err := d.cfg.Limiter.Reserve(d.cfg.Routine); err != nil {
		return api.Session{}, err
	}
	raw, _ := json.Marshal(map[string]string{"text": name})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		d.cfg.BaseURL+"/v1/claude_code/routines/"+url.PathEscape(d.cfg.Routine)+"/fire", bytes.NewReader(raw))
	if err != nil {
		return api.Session{}, err
	}
	req.Header.Set("Authorization", "Bearer "+d.cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := d.http.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return api.Session{}, fmt.Errorf("fire: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return api.Session{}, fmt.Errorf("fire: read reply: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return api.Session{}, fmt.Errorf("fire: HTTP %d", resp.StatusCode)
	}
	var out struct {
		SessionID  string `json:"session_id"`
		SessionURL string `json:"session_url"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.SessionID == "" {
		return api.Session{}, errors.New("fire: reply has no session id")
	}
	s := api.Session{Key: key, ID: out.SessionID, URL: out.SessionURL, Ticket: b.Ticket, Attempt: b.Attempt, Dispatcher: d.Name(), StartedAt: d.cfg.Now()}
	d.fired[key] = s
	return s, nil
}

// Steer returns ErrUnsupported: the fire endpoint cannot message a session.
func (d *Dispatcher) Steer(context.Context, api.Session, string) error { return ErrUnsupported }

// Cancel returns ErrUnsupported: the fire endpoint cannot stop a session.
func (d *Dispatcher) Cancel(context.Context, api.Session) error { return ErrUnsupported }

// Usage returns the zero Usage: the fire endpoint reports none, and unknown is never guessed.
func (d *Dispatcher) Usage(context.Context, api.Session) (api.Usage, error) {
	return api.Usage{}, nil
}
