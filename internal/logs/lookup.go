package logs

import (
	"context"
	"errors"
	"net/http"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/store"
)

// StoreLookup returns a SessionLookup that reads the newest recorded session from st.
// A ticket with none gives store.ErrSessionNotRecorded.
func StoreLookup(st *store.Store) SessionLookup {
	return st.LatestSession
}

// RunLogClient reads one page of a routines session's run log after a cursor.
type RunLogClient interface {
	RunLog(ctx context.Context, sessionID, cursor string) (Page, error)
}

type runLogSource struct {
	c  RunLogClient
	id string
}

func (r runLogSource) Poll(ctx context.Context, cursor string) (Page, error) {
	return r.c.RunLog(ctx, r.id, cursor)
}

// RoutinesFactory returns the Backends factory for sessions run by the routines dispatcher.
// Its Source reads the session's run log through c.
func RoutinesFactory(c RunLogClient) func(api.Session) (Source, error) {
	return func(s api.Session) (Source, error) {
		if s.ID == "" {
			return nil, errors.New("logs: routines session has no id")
		}
		return runLogSource{c: c, id: s.ID}, nil
	}
}

// httpRunLog is a RunLogClient over the routines HTTP API.
type httpRunLog struct {
	baseURL, token string
	client         *http.Client
}

// NewHTTPRunLog returns a RunLogClient that reads run logs from the routines API at baseURL.
// A nil client means a default one with a timeout.
func NewHTTPRunLog(baseURL, token string, client *http.Client) RunLogClient {
	return httpRunLog{baseURL: baseURL, token: token, client: client}
}

func (h httpRunLog) RunLog(ctx context.Context, sessionID, cursor string) (Page, error) {
	r, err := NewRoutines(RoutinesConfig{BaseURL: h.baseURL, Token: h.token, SessionID: sessionID, HTTP: h.client})
	if err != nil {
		return Page{}, err
	}
	return r.Poll(ctx, cursor)
}

// LocalFactory returns the Backends factory for sessions run by the local dispatcher. path names
// the session's output file and ended says whether its process has exited.
func LocalFactory(path func(api.Session) string, ended func(context.Context, api.Session) (bool, error)) func(api.Session) (Source, error) {
	return func(s api.Session) (Source, error) {
		l := &Local{Path: path(s)}
		if ended != nil {
			l.Ended = func(ctx context.Context) (bool, error) { return ended(ctx, s) }
		}
		return l, nil
	}
}
