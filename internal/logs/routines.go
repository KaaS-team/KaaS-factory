package logs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// RoutinesConfig holds what the routines run-log source needs. Nothing is
// read from the environment here.
type RoutinesConfig struct {
	BaseURL   string
	Token     string
	SessionID string
	HTTP      *http.Client
}

// Routines reads a session's run log from the routines API.
//
// The endpoint and reply shape are this package's assumption, like the rest
// of the routines client: GET /v1/code/sessions/{id}/events?after=<cursor>
// answers {"data":[{"id","time","kind","text"}],"next":"","has_more":false,
// "status":"running"}. The golden in testdata pins what this client expects.
type Routines struct{ cfg RoutinesConfig }

// NewRoutines returns a Source over the routines API.
func NewRoutines(cfg RoutinesConfig) (*Routines, error) {
	if cfg.BaseURL == "" || cfg.Token == "" || cfg.SessionID == "" {
		return nil, fmt.Errorf("logs: base URL, token and session id are required")
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	return &Routines{cfg: cfg}, nil
}

// endedStatuses are the session statuses after which no more events come.
var endedStatuses = map[string]bool{
	"completed": true, "succeeded": true, "failed": true,
	"canceled": true, "cancelled": true, "stopped": true, "ended": true,
}

// Poll fetches the events after cursor. Errors carry the status code, never
// the URL, the token or the body.
func (r *Routines) Poll(ctx context.Context, cursor string) (Page, error) {
	u := r.cfg.BaseURL + "/v1/code/sessions/" + url.PathEscape(r.cfg.SessionID) + "/events"
	if cursor != "" {
		u += "?after=" + url.QueryEscape(cursor)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return Page{}, err
	}
	req.Header.Set("Authorization", "Bearer "+r.cfg.Token)
	req.Header.Set("Accept", "application/json")
	resp, err := r.cfg.HTTP.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return Page{}, fmt.Errorf("logs: read run log: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return Page{}, fmt.Errorf("logs: read run log: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return Page{}, fmt.Errorf("logs: read run log: HTTP %d", resp.StatusCode)
	}
	var body struct {
		Data    []Event `json:"data"`
		Next    string  `json:"next"`
		HasMore bool    `json:"has_more"`
		Status  string  `json:"status"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return Page{}, fmt.Errorf("logs: read run log: reply is not the expected JSON")
	}
	next := body.Next
	if next == "" {
		next = cursor
	}
	return Page{Events: body.Data, Next: next, More: body.HasMore, Done: endedStatuses[body.Status] && !body.HasMore}, nil
}
