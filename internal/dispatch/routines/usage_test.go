package routines

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

func eventsServer(t *testing.T, status int, body string) *Dispatcher {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/code/sessions/sess_a/events" || r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(404)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	d, err := New(Config{BaseURL: srv.URL, Token: token, Now: time.Now})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// Symphony §13.5: absolute totals. The recorded run log ends in a result event;
// its totals win over the earlier usage events.
func TestEventUsageReadsTheRecordedRunLog(t *testing.T) {
	raw, err := os.ReadFile("testdata/session_events.json")
	if err != nil {
		t.Fatal(err)
	}
	d := eventsServer(t, 200, string(raw))
	got, err := d.EventUsage(context.Background(), api.Session{ID: "sess_a"})
	want := api.Usage{InputTokens: 900, OutputTokens: 210, CacheReadTokens: 70, CacheWriteTokens: 9, CostUSD: 0.61}
	if err != nil || got != want {
		t.Errorf("got %+v %v, want %+v", got, err, want)
	}
}

func TestEventUsageBranches(t *testing.T) {
	rows := []struct {
		name, body string
		status     int
		want       api.Usage
		noUsage    bool
		kind       Kind
	}{
		{"latest usage event when the run has no result yet", `{"data":[{"type":"usage","usage":{"input_tokens":1,"output_tokens":2}},{"type":"usage","usage":{"input_tokens":3,"output_tokens":4}}]}`, 200, api.Usage{InputTokens: 3, OutputTokens: 4}, false, ""},
		{"no events", `{"data":[]}`, 200, api.Usage{}, true, ""},
		{"events without usage", `{"data":[{"type":"message"},{"type":"result"}]}`, 200, api.Usage{}, true, ""},
		{"usage object of zeros is still a report", `{"data":[{"type":"result","usage":{"input_tokens":0,"output_tokens":0}}]}`, 200, api.Usage{}, false, ""},
		{"null usage", `{"data":[{"type":"result","usage":null}]}`, 200, api.Usage{}, true, ""},
		{"server error is an error, not unknown", `{}`, 500, api.Usage{}, false, KindProvider},
	}
	for _, r := range rows {
		got, err := eventsServer(t, r.status, r.body).EventUsage(context.Background(), api.Session{ID: "sess_a"})
		var re *Error
		switch {
		case r.noUsage:
			if !errors.Is(err, ErrNoUsage) {
				t.Errorf("%s: err %v, want ErrNoUsage", r.name, err)
			}
		case r.kind != "":
			if !errors.As(err, &re) || re.Kind != r.kind || errors.Is(err, ErrNoUsage) {
				t.Errorf("%s: err %v", r.name, err)
			}
		case err != nil || got != r.want:
			t.Errorf("%s: got %+v %v", r.name, got, err)
		}
	}
}
