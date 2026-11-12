package serve

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// fakeCore is a Core whose Run blocks until released, so tests control the tick in flight.
type fakeCore struct {
	*porttest.Control
	release chan struct{}
	started chan struct{}
	runErr  error
}

func newFakeCore() *fakeCore {
	return &fakeCore{Control: porttest.NewControl(api.Board{}), release: make(chan struct{}), started: make(chan struct{})}
}

func (f *fakeCore) Run(ctx context.Context) error {
	close(f.started)
	<-ctx.Done()
	<-f.release
	return f.runErr
}

// TestHealthz_Symphony8_1: the poll loop is alive while its last tick is younger than 3 intervals.
func TestHealthz_Symphony8_1(t *testing.T) {
	const iv = 10 * time.Second
	tests := []struct {
		name string
		tick bool
		age  time.Duration
		want int
	}{
		{"fresh tick", true, iv, http.StatusOK},
		{"just under 3 ticks", true, 3*iv - time.Nanosecond, http.StatusOK},
		{"exactly 3 ticks is stale", true, 3 * iv, http.StatusServiceUnavailable},
		{"stale tick", true, 5 * iv, http.StatusServiceUnavailable},
		{"never ticked", false, 0, http.StatusServiceUnavailable},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clk := &fakeClock{t: time.Unix(1_000_000, 0)}
			s := New(newFakeCore(), Options{Interval: iv, Clock: clk})
			if tc.tick {
				s.markTick()
				clk.Add(tc.age)
			}
			rec := httptest.NewRecorder()
			s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
			if rec.Code != tc.want {
				t.Fatalf("code = %d, want %d (%s)", rec.Code, tc.want, rec.Body)
			}
		})
	}
}

// TestReadyz: ready once the core loop has started, not before.
func TestReadyz(t *testing.T) {
	s := New(newFakeCore(), Options{Interval: time.Second, Clock: &fakeClock{}})
	get := func() int {
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		return rec.Code
	}
	if got := get(); got != http.StatusServiceUnavailable {
		t.Fatalf("before start = %d", got)
	}
	s.ready.Store(true)
	if got := get(); got != http.StatusOK {
		t.Fatalf("after start = %d", got)
	}
}

// TestEvents_StreamsFirstEvent: /events serves the first event the core emits as server-sent events.
func TestEvents_StreamsFirstEvent(t *testing.T) {
	fc := newFakeCore()
	s := New(fc, Options{Interval: time.Second, Clock: &fakeClock{}})
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	<-fc.Subscribed()
	fc.Push(api.Event{V: api.EventVersion, Kind: "tick", Ticket: "T-1"})
	sc := bufio.NewScanner(resp.Body)
	var data string
	for sc.Scan() {
		if l := sc.Text(); strings.HasPrefix(l, "data: ") {
			data = strings.TrimPrefix(l, "data: ")
			break
		}
	}
	var ev api.Event
	if err := json.Unmarshal([]byte(data), &ev); err != nil {
		t.Fatalf("data %q: %v", data, err)
	}
	if ev.Kind != "tick" || ev.Ticket != "T-1" {
		t.Fatalf("event %+v", ev)
	}
}

func startServe(t *testing.T, s *Server, drain time.Duration) (cancel func(), done chan error) {
	t.Helper()
	ctx, c := context.WithCancel(context.Background())
	done = make(chan error, 1)
	go func() { done <- s.Serve(ctx, "127.0.0.1:0", drain) }()
	return c, done
}

// TestServe_DrainExitsZeroAfterRelease: SIGTERM stops dispatching; the tick in flight finishes
// inside the drain window and Serve returns nil.
func TestServe_DrainExitsZeroAfterRelease(t *testing.T) {
	fc := newFakeCore()
	s := New(fc, Options{Interval: time.Second})
	cancel, done := startServe(t, s, 30*time.Second)
	<-fc.started
	cancel()
	select {
	case err := <-done:
		t.Fatalf("returned before release: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(fc.release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("did not exit after release")
	}
}

// TestServe_DrainTimeoutIsAnError: a tick stuck past --drain returns an error naming the drain.
func TestServe_DrainTimeoutIsAnError(t *testing.T) {
	fc := newFakeCore()
	defer close(fc.release)
	s := New(fc, Options{Interval: time.Second})
	cancel, done := startServe(t, s, 50*time.Millisecond)
	<-fc.started
	cancel()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "drain") {
			t.Fatalf("err = %v, want drain message", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("did not exit after drain")
	}
}

// TestServe_OpenEventStreamDoesNotBlockDrain: a client still on /events does not hold the exit.
func TestServe_OpenEventStreamDoesNotBlockDrain(t *testing.T) {
	fc := newFakeCore()
	close(fc.release)
	s := New(fc, Options{Interval: time.Second})
	ctx, cancel := context.WithCancel(context.Background())
	ln := make(chan string, 1)
	s.onListen = func(a string) { ln <- a }
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, "127.0.0.1:0", 5*time.Second) }()
	addr := <-ln
	resp, err := http.Get("http://" + addr + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("blocked by open stream")
	}
}
