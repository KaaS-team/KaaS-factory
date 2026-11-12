// Package routines is an api.Dispatcher that starts a coding-agent session
// through the routines HTTP API: it creates a disabled trigger with no
// schedule, runs it, and watches the session.
//
// The request and response shapes below are this package's assumption of the
// API. They are not confirmed against the live service; the recorded goldens
// in testdata pin what this client sends, not what the service accepts.
package routines

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
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/dispatch/brief"
)

// Kind classifies an API failure.
type Kind string

// The failure kinds, matching src/cloud/port.ts.
const (
	KindAuth        Kind = "auth"
	KindNotFound    Kind = "not_found"
	KindRateLimited Kind = "rate_limited"
	KindProvider    Kind = "provider"
)

// Error is a failed API call. It carries the status and kind, never the
// request or response body.
type Error struct {
	Kind   Kind
	Status int
	Op     string
}

func (e *Error) Error() string {
	return fmt.Sprintf("routines: %s: %s (HTTP %d)", e.Op, e.Kind, e.Status)
}

// ErrSteerUnsupported is returned by Steer: the routines API has no way to
// message a running session.
var ErrSteerUnsupported = errors.New("routines: steer is not supported")

// Config holds what the caller injects. BaseURL and Token come from the
// operator's login; nothing is read from the environment here.
type Config struct {
	BaseURL       string
	Token         string
	HTTP          *http.Client
	MaxConcurrent int
	Now           func() time.Time
}

// Dispatcher implements api.Dispatcher over the routines API.
type Dispatcher struct {
	cfg  Config
	http *http.Client
}

// New checks cfg and returns a Dispatcher.
func New(cfg Config) (*Dispatcher, error) {
	if cfg.BaseURL == "" || cfg.Token == "" {
		return nil, errors.New("routines: base URL and token are required")
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
	return &Dispatcher{cfg: cfg, http: h}, nil
}

// Name returns "routines".
func (d *Dispatcher) Name() string { return "routines" }

// Caps reports a remote dispatcher that cannot push workflow files.
func (d *Dispatcher) Caps() api.Caps {
	return api.Caps{MaxConcurrent: d.cfg.MaxConcurrent, CanPushWorkflows: false, Remote: true}
}

type trigger struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type session struct {
	ID        string `json:"id"`
	TriggerID string `json:"trigger_id"`
	Status    string `json:"status"`
	URL       string `json:"url"`
	Usage     *struct {
		InputTokens      int64   `json:"input_tokens"`
		OutputTokens     int64   `json:"output_tokens"`
		CacheReadTokens  int64   `json:"cache_read_tokens"`
		CacheWriteTokens int64   `json:"cache_write_tokens"`
		CostUSD          float64 `json:"cost_usd"`
	} `json:"usage"`
}

type list[T any] struct {
	Data []T `json:"data"`
}

// SessionKey is the idempotency key for a ticket attempt.
func SessionKey(t api.TicketID, attempt int) string { return fmt.Sprintf("factory-%s-a%d", t, attempt) }

// Dispatch finds or creates the trigger named for this attempt, runs it if no
// session exists for it, and returns the session. Calling it again with the
// same ticket and attempt returns the same session and creates nothing.
func (d *Dispatcher) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	name, err := brief.Name(b.Ticket, b.Attempt)
	if err != nil {
		return api.Session{}, err
	}
	if b.Name != name {
		return api.Session{}, fmt.Errorf("routines: brief is named %q, want %q", b.Name, name)
	}
	key := SessionKey(b.Ticket, b.Attempt)

	var found list[trigger]
	if err := d.do(ctx, "find trigger", http.MethodGet, "/v1/code/triggers?name="+url.QueryEscape(key), nil, &found); err != nil {
		return api.Session{}, err
	}
	var trig trigger
	for _, t := range found.Data {
		if t.Name == key {
			trig = t
			break
		}
	}
	if trig.ID == "" {
		body := map[string]any{
			"name":    key,
			"enabled": false,
			"prompt":  brief.Prompt(b.Name),
			"repo":    b.Repo,
			"branch":  b.Base,
		}
		if err := d.do(ctx, "create trigger", http.MethodPost, "/v1/code/triggers", body, &trig); err != nil {
			return api.Session{}, err
		}
		if trig.ID == "" {
			return api.Session{}, &Error{Kind: KindProvider, Op: "create trigger", Status: http.StatusOK}
		}
	}

	var existing list[session]
	if err := d.do(ctx, "find session", http.MethodGet, "/v1/code/sessions?trigger_id="+url.QueryEscape(trig.ID), nil, &existing); err != nil {
		return api.Session{}, err
	}
	var s session
	if len(existing.Data) > 0 {
		s = existing.Data[0]
	} else if err := d.do(ctx, "run trigger", http.MethodPost, "/v1/code/triggers/"+url.PathEscape(trig.ID)+"/run", struct{}{}, &s); err != nil {
		return api.Session{}, err
	}
	return api.Session{
		Key: key, ID: s.ID, URL: s.URL, Ticket: b.Ticket, Attempt: b.Attempt,
		Dispatcher: d.Name(), StartedAt: d.cfg.Now(),
	}, nil
}

// Steer always returns ErrSteerUnsupported.
func (d *Dispatcher) Steer(context.Context, api.Session, string) error { return ErrSteerUnsupported }

// Cancel asks the API to stop the session.
func (d *Dispatcher) Cancel(ctx context.Context, s api.Session) error {
	return d.do(ctx, "cancel session", http.MethodPost, "/v1/code/sessions/"+url.PathEscape(s.ID)+"/cancel", struct{}{}, nil)
}

// Usage returns the usage the API reports for the session, or the zero Usage
// when it reports none (unknown, never guessed).
func (d *Dispatcher) Usage(ctx context.Context, s api.Session) (api.Usage, error) {
	got, err := d.session(ctx, s)
	if err != nil || got.Usage == nil {
		return api.Usage{}, err
	}
	u := got.Usage
	return api.Usage{
		InputTokens: u.InputTokens, OutputTokens: u.OutputTokens,
		CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens, CostUSD: u.CostUSD,
	}, nil
}

// Status returns the API's status text for the session, such as "running".
func (d *Dispatcher) Status(ctx context.Context, s api.Session) (string, error) {
	got, err := d.session(ctx, s)
	return got.Status, err
}

func (d *Dispatcher) session(ctx context.Context, s api.Session) (session, error) {
	var l list[session]
	if err := d.do(ctx, "get session", http.MethodGet, "/v1/code/sessions?id="+url.QueryEscape(s.ID), nil, &l); err != nil {
		return session{}, err
	}
	for _, got := range l.Data {
		if got.ID == s.ID {
			return got, nil
		}
	}
	return session{}, &Error{Kind: KindNotFound, Status: http.StatusNotFound, Op: "get session"}
}

func (d *Dispatcher) do(ctx context.Context, op, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.cfg.BaseURL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+d.cfg.Token)
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.http.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // the URL is not part of the message
		}
		return fmt.Errorf("routines: %s: %w", op, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("routines: %s: read reply: %w", op, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &Error{Kind: kindOf(resp.StatusCode), Status: resp.StatusCode, Op: op}
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("routines: %s: reply is not the expected JSON", op)
		}
	}
	return nil
}

func kindOf(status int) Kind {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return KindAuth
	case http.StatusNotFound:
		return KindNotFound
	case http.StatusTooManyRequests:
		return KindRateLimited
	}
	return KindProvider
}

// ErrNoUsage is returned by EventUsage when the session events carry no usage.
// It means unknown, never zero.
var ErrNoUsage = errors.New("routines: session reports no usage")

type event struct {
	Type  string   `json:"type"`
	Usage *usageIn `json:"usage"`
}

type usageIn struct {
	InputTokens      int64   `json:"input_tokens"`
	OutputTokens     int64   `json:"output_tokens"`
	CacheReadTokens  int64   `json:"cache_read_tokens"`
	CacheWriteTokens int64   `json:"cache_write_tokens"`
	CostUSD          float64 `json:"cost_usd"`
}

// EventUsage reads the session's events and returns the absolute usage totals
// from the result event, or else from the last usage event (Symphony §13.5).
// It returns ErrNoUsage when no event carries usage. The events endpoint shape
// is this package's assumption, like the rest of the API here.
func (d *Dispatcher) EventUsage(ctx context.Context, s api.Session) (api.Usage, error) {
	var l list[event]
	if err := d.do(ctx, "get session events", http.MethodGet, "/v1/code/sessions/"+url.PathEscape(s.ID)+"/events", nil, &l); err != nil {
		return api.Usage{}, err
	}
	var last *usageIn
	for _, e := range l.Data {
		if e.Usage == nil || (e.Type != "result" && e.Type != "usage") {
			continue
		}
		if e.Type == "result" {
			last = e.Usage
			break
		}
		last = e.Usage
	}
	if last == nil {
		return api.Usage{}, ErrNoUsage
	}
	return api.Usage{
		InputTokens: last.InputTokens, OutputTokens: last.OutputTokens,
		CacheReadTokens: last.CacheReadTokens, CacheWriteTokens: last.CacheWriteTokens, CostUSD: last.CostUSD,
	}, nil
}
