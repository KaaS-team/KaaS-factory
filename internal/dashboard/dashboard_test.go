package dashboard

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// fakeControl is a read-side Control. Any write call fails the test.
type fakeControl struct {
	t      *testing.T
	board  api.Board
	events chan api.Event
	subs   atomic.Int32
	subbed chan struct{}
	once   sync.Once
}

func newFake(t *testing.T) *fakeControl {
	return &fakeControl{t: t, events: make(chan api.Event, 8), subbed: make(chan struct{})}
}

func (f *fakeControl) Board(context.Context) (api.Board, error) { return f.board, nil }
func (f *fakeControl) Dispatch(context.Context, api.TicketID) error {
	f.t.Error("dashboard called Dispatch")
	return nil
}
func (f *fakeControl) Steer(context.Context, api.TicketID, string) error {
	f.t.Error("dashboard called Steer")
	return nil
}
func (f *fakeControl) Cancel(context.Context, api.TicketID) error {
	f.t.Error("dashboard called Cancel")
	return nil
}
func (f *fakeControl) Retry(context.Context, api.TicketID) error {
	f.t.Error("dashboard called Retry")
	return nil
}
func (f *fakeControl) Events(ctx context.Context) (<-chan api.Event, error) {
	f.subs.Add(1)
	out := make(chan api.Event)
	go func() {
		defer f.subs.Add(-1)
		f.once.Do(func() { close(f.subbed) })
		for {
			select {
			case <-ctx.Done():
				return
			case e := <-f.events:
				select {
				case out <- e:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, nil
}

func sampleBoard() api.Board {
	mk := func(id, title string, p api.Phase) api.Slot {
		return api.Slot{
			Ticket:   api.Ticket{ID: api.TicketID(id), Title: title, Priority: 1},
			Phase:    p,
			Session:  &api.Session{ID: "sess-" + id, Dispatcher: "local"},
			LastPush: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
			Usage:    api.Usage{InputTokens: 123456, OutputTokens: 7654, CostUSD: 4.321},
			Budget:   api.Budget{Tokens: 999000, USD: 12.5},
		}
	}
	return api.Board{
		Slots: []api.Slot{
			mk("101", "Alpha task", api.PhaseRunning),
			mk("102", "Beta <b>task</b>", api.PhaseStalled),
			mk("103", "Gamma task", api.PhaseDone),
		},
		Ready:      []api.Ticket{{ID: "201", Title: "Waiting one"}},
		MergeQueue: []api.TicketID{"103"},
		FiresLeft:  5,
	}
}

func get(t *testing.T, h http.Handler, path string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec.Code, rec.Body.String()
}

// Acceptance: GET / renders every slot of a fake Board.
func TestBoardRendersEverySlot(t *testing.T) {
	f := newFake(t)
	f.board = sampleBoard()
	code, body := get(t, Handler(f, Options{}), "/")
	if code != 200 {
		t.Fatalf("status %d", code)
	}
	for _, s := range f.board.Slots {
		if !strings.Contains(body, string(s.Ticket.ID)) || !strings.Contains(body, string(s.Phase)) {
			t.Errorf("slot %s missing from board", s.Ticket.ID)
		}
	}
	if !strings.Contains(body, "Beta &lt;b&gt;task&lt;/b&gt;") {
		t.Error("title is not escaped")
	}
}

func TestQueueAndTimelinePages(t *testing.T) {
	f := newFake(t)
	f.board = sampleBoard()
	h := Handler(f, Options{})
	_, q := get(t, h, "/queue")
	if !strings.Contains(q, "201") || !strings.Contains(q, "103") {
		t.Errorf("queue page misses ready or merge queue: %s", q)
	}
	code, tl := get(t, h, "/ticket/101")
	if code != 200 || !strings.Contains(tl, "Alpha task") {
		t.Errorf("timeline %d %s", code, tl)
	}
	if code, _ := get(t, h, "/ticket/nope"); code != 404 {
		t.Errorf("unknown ticket status %d", code)
	}
	if code, _ := get(t, h, "/other"); code != 404 {
		t.Errorf("unknown path status %d", code)
	}
}

// Acceptance: operator off hides usage, budget, cost and model everywhere.
func TestOperatorGate(t *testing.T) {
	secrets := []string{"123456", "7654", "4.32", "999000", "12.5", "usage", "budget", "cost", "model", "claude"}
	for _, tc := range []struct {
		name string
		op   bool
	}{{"off", false}, {"on", true}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t)
			f.board = sampleBoard()
			h := Handler(f, Options{Operator: tc.op})
			for _, p := range []string{"/", "/queue", "/ticket/101"} {
				_, body := get(t, h, p)
				low := strings.ToLower(body)
				if tc.op {
					if p != "/queue" && !strings.Contains(body, "123456") {
						t.Errorf("%s: operator view lacks usage", p)
					}
					continue
				}
				for _, s := range secrets {
					if strings.Contains(low, s) {
						t.Errorf("%s leaks %q", p, s)
					}
				}
			}
		})
	}
}

// Acceptance: no route accepts POST, PUT, PATCH or DELETE.
func TestNoWriteRoutes(t *testing.T) {
	f := newFake(t)
	f.board = sampleBoard()
	h := Handler(f, Options{Operator: true})
	for _, pat := range routes() {
		method, path, ok := strings.Cut(pat, " ")
		if !ok || method != http.MethodGet {
			t.Fatalf("route %q is not GET only", pat)
		}
		path = strings.NewReplacer("{id}", "101", "{$}", "").Replace(path)
		for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(m, path, nil))
			if rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s %s = %d, want 405", m, path, rec.Code)
			}
		}
	}
}

func readEvent(t *testing.T, r *bufio.Reader) api.Event {
	t.Helper()
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if rest, ok := strings.CutPrefix(line, "data: "); ok {
			var e api.Event
			if err := json.Unmarshal([]byte(rest), &e); err != nil {
				t.Fatalf("decode: %v", err)
			}
			return e
		}
	}
}

// Acceptance: /events streams api.Event JSON and closing the client releases the subscription.
func TestEventsStreamsAndReleases(t *testing.T) {
	f := newFake(t)
	srv := httptest.NewServer(Handler(f, Options{Operator: true}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("content type %q", ct)
	}
	<-f.subbed
	f.events <- api.Event{V: api.EventVersion, Kind: "phase", Ticket: "101", Data: map[string]any{"to": "running"}}
	got := readEvent(t, bufio.NewReader(resp.Body))
	if got.Kind != "phase" || got.Ticket != "101" {
		t.Errorf("event %+v", got)
	}
	cancel()
	_ = resp.Body.Close()
	deadline := time.Now().Add(3 * time.Second)
	for f.subs.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("subscription not released after client closed")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestEventsHideUsageWithoutOperator(t *testing.T) {
	f := newFake(t)
	srv := httptest.NewServer(Handler(f, Options{}))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	<-f.subbed
	f.events <- api.Event{V: 1, Kind: "usage", Ticket: "101", Data: map[string]any{"cost_usd": 3.2}}
	f.events <- api.Event{V: 1, Kind: "phase", Ticket: "101", Data: map[string]any{"model": "x", "to": "done"}}
	got := readEvent(t, bufio.NewReader(resp.Body))
	if got.Kind != "phase" || got.Data != nil {
		t.Errorf("want the phase event with no data, got %+v", got)
	}
}

// Acceptance: default address is 127.0.0.1.
func TestDefaultAddrIsLoopback(t *testing.T) {
	cmd := NewCommand()
	if cmd.Use != "dashboard" {
		t.Errorf("use %q", cmd.Use)
	}
	addr := cmd.Flags().Lookup("addr")
	if addr == nil || !strings.HasPrefix(addr.DefValue, "127.0.0.1:") {
		t.Fatalf("addr flag %+v", addr)
	}
	if op := cmd.Flags().Lookup("operator"); op == nil || op.DefValue != "false" {
		t.Errorf("operator flag %+v", op)
	}
}

func TestCommandNeedsControl(t *testing.T) {
	cmd := NewCommand()
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(nil)
	if err := cmd.ExecuteContext(context.Background()); err == nil {
		t.Error("want an error without a Control in the context")
	}
}

func TestCommandServesAndStops(t *testing.T) {
	f := newFake(t)
	f.board = sampleBoard()
	ctx, cancel := context.WithCancel(WithControl(context.Background(), f))
	cmd := NewCommand()
	cmd.SetOut(io.Discard)
	cmd.SetArgs([]string{"--addr", "127.0.0.1:0"})
	done := make(chan error, 1)
	go func() { done <- cmd.ExecuteContext(ctx) }()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("command did not stop on context cancel")
	}
}
