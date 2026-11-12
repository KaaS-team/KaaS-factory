package fire

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newClock() *clock { return &clock{t: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)} }

func TestLimiterPerRoutine(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.Now)
	for i := 1; i <= 30; i++ {
		if err := l.Reserve("rt_1"); err != nil {
			t.Fatalf("fire %d: %v", i, err)
		}
	}
	var re *RateError
	err := l.Reserve("rt_1")
	if !errors.As(err, &re) || re.Scope != ScopeRoutine || !errors.Is(err, ErrRateLimited) {
		t.Fatalf("31st: %v", err)
	}
	// Another routine is unaffected.
	if err := l.Reserve("rt_2"); err != nil {
		t.Fatalf("other routine: %v", err)
	}
	// The window slides: just short of an hour is still full, an hour later is free.
	c.Advance(59*time.Minute + 59*time.Second)
	if err := l.Reserve("rt_1"); err == nil {
		t.Fatal("fire allowed before the window passed")
	}
	if !re.RetryAt.Equal(time.Date(2026, 11, 12, 11, 0, 0, 0, time.UTC)) {
		t.Errorf("retry at %v", re.RetryAt)
	}
	c.Advance(time.Second)
	if err := l.Reserve("rt_1"); err != nil {
		t.Fatalf("after the window: %v", err)
	}
}

func TestLimiterSlidesFireByFire(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.Now)
	for i := 0; i < 30; i++ {
		if err := l.Reserve("r"); err != nil {
			t.Fatal(err)
		}
		c.Advance(time.Minute) // fires spread over 30 minutes
	}
	// At minute 30 the first fire (minute 0) is still inside the hour.
	if err := l.Reserve("r"); err == nil {
		t.Fatal("allowed")
	}
	c.Advance(30 * time.Minute) // minute 60: only the minute-0 fire has left
	if err := l.Reserve("r"); err != nil {
		t.Fatalf("one slot freed: %v", err)
	}
	if err := l.Reserve("r"); err == nil {
		t.Fatal("only one slot should be free")
	}
}

func TestLimiterPerAccount(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.Now)
	routines := []string{"a", "b", "c", "d"}
	for i := 0; i < 100; i++ {
		if err := l.Reserve(routines[i%4]); err != nil {
			t.Fatalf("fire %d: %v", i+1, err)
		}
	}
	var re *RateError
	if err := l.Reserve("e"); !errors.As(err, &re) || re.Scope != ScopeAccount {
		t.Fatalf("101st: %v", err)
	}
	if l.Left("e") != 0 {
		t.Errorf("left = %d", l.Left("e"))
	}
	c.Advance(time.Hour)
	if err := l.Reserve("e"); err != nil {
		t.Fatalf("after the window: %v", err)
	}
	if l.Left("e") != 29 {
		t.Errorf("left = %d, want 29", l.Left("e"))
	}
}

func TestLimiterRefusalDoesNotCount(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.Now)
	for i := 0; i < 30; i++ {
		_ = l.Reserve("r")
	}
	for i := 0; i < 10; i++ {
		_ = l.Reserve("r") // refused
	}
	// If the refusals had counted, the account would be full before 100 real fires.
	for _, r := range []struct {
		name string
		n    int
	}{{"x", 30}, {"y", 30}, {"z", 10}} {
		for i := 0; i < r.n; i++ {
			if err := l.Reserve(r.name); err != nil {
				t.Fatalf("%s fire %d: %v", r.name, i+1, err)
			}
		}
	}
	if err := l.Reserve("z"); err == nil {
		t.Fatal("101st fire allowed")
	}
}

type server struct {
	calls []string
	body  []string
	auth  []string
	reply func(w http.ResponseWriter)
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	s.calls = append(s.calls, r.Method+" "+r.URL.Path)
	s.body = append(s.body, string(raw))
	s.auth = append(s.auth, r.Header.Get("Authorization"))
	if s.reply != nil {
		s.reply(w)
		return
	}
	_, _ = w.Write([]byte(`{"session_id":"sess_1","session_url":"https://example.test/s/1"}`))
}

var bf = api.Brief{Ticket: "7", Attempt: 1, Name: "v9-7-a1.md", Repo: "o/r", Base: "main", Branch: "factory/7-a1", Text: "x"}

func newDispatcher(t *testing.T, s *server, c *clock, l *Limiter, routine string) *Dispatcher {
	t.Helper()
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	d, err := New(Config{BaseURL: srv.URL, Token: "tok-9", Routine: routine, Limiter: l, Now: c.Now})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// Acceptance: the 31st fire in an hour for one routine and the 101st for the account
// return a rate error without an HTTP call.
func TestDispatchRateErrorMakesNoHTTPCall(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.Now)
	s := &server{}
	d := newDispatcher(t, s, c, l, "rt_1")
	for i := 1; i <= 30; i++ {
		b := bf
		b.Attempt, b.Name = i, "v9-7-a"+itoa(i)+".md"
		if _, err := d.Dispatch(context.Background(), b); err != nil {
			t.Fatalf("fire %d: %v", i, err)
		}
	}
	b := bf
	b.Attempt, b.Name = 31, "v9-7-a31.md"
	before := len(s.calls)
	_, err := d.Dispatch(context.Background(), b)
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("31st: %v", err)
	}
	if len(s.calls) != before {
		t.Errorf("the refused fire made %d HTTP calls", len(s.calls)-before)
	}
	c.Advance(time.Hour)
	if _, err := d.Dispatch(context.Background(), b); err != nil {
		t.Fatalf("after the window: %v", err)
	}

	// The account limit: other routines share the limiter.
	acc := &server{}
	l2 := NewLimiter(c.Now)
	ds := []*Dispatcher{}
	for _, r := range []string{"a", "b", "c", "d"} {
		ds = append(ds, newDispatcher(t, acc, c, l2, r))
	}
	for i := 0; i < 100; i++ {
		b := bf
		b.Attempt, b.Name = i+1, "v9-7-a"+itoa(i+1)+".md"
		if _, err := ds[i%4].Dispatch(context.Background(), b); err != nil {
			t.Fatalf("fire %d: %v", i+1, err)
		}
	}
	b101 := bf
	b101.Attempt, b101.Name = 101, "v9-7-a101.md"
	n := len(acc.calls)
	var re *RateError
	if _, err := ds[0].Dispatch(context.Background(), b101); !errors.As(err, &re) || re.Scope != ScopeAccount {
		t.Fatalf("101st: %v", err)
	}
	if len(acc.calls) != n {
		t.Error("the 101st fire made an HTTP call")
	}
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

func TestDispatchRequestAndSession(t *testing.T) {
	c := newClock()
	s := &server{}
	d := newDispatcher(t, s, c, NewLimiter(c.Now), "rt_1")
	got, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.calls) != 1 || s.calls[0] != "POST /v1/claude_code/routines/rt_1/fire" || s.body[0] != `{"text":"v9-7-a1.md"}` || s.auth[0] != "Bearer tok-9" {
		t.Errorf("request: %v %v %v", s.calls, s.body, s.auth)
	}
	want := api.Session{Key: "factory-7-a1", ID: "sess_1", URL: "https://example.test/s/1", Ticket: "7", Attempt: 1, Dispatcher: "fire", StartedAt: c.Now()}
	if got != want {
		t.Errorf("session %+v", got)
	}
	// The same key again returns the same session and fires nothing.
	again, err := d.Dispatch(context.Background(), bf)
	if err != nil || again != got || len(s.calls) != 1 {
		t.Errorf("second dispatch: %+v %v calls=%d", again, err, len(s.calls))
	}
}

func TestDispatchFailureStillCountsAndNeverLeaksTheBody(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.Now)
	s := &server{reply: func(w http.ResponseWriter) { w.WriteHeader(500); _, _ = w.Write([]byte("secret detail tok-9")) }}
	d := newDispatcher(t, s, c, l, "rt_1")
	_, err := d.Dispatch(context.Background(), bf)
	if err == nil || strings.Contains(err.Error(), "secret detail") || strings.Contains(err.Error(), "tok-9") {
		t.Fatalf("err = %v", err)
	}
	if l.Left("rt_1") != 29 {
		t.Errorf("a fire that reached the server must count: left %d", l.Left("rt_1"))
	}
	// A failed fire is not remembered as a session, so a retry fires again.
	s.reply = nil
	if _, err := d.Dispatch(context.Background(), bf); err != nil {
		t.Fatal(err)
	}
}

func TestDispatchRefusesAWrongBriefName(t *testing.T) {
	c := newClock()
	s := &server{}
	l := NewLimiter(c.Now)
	d := newDispatcher(t, s, c, l, "rt_1")
	b := bf
	b.Name = "other.md"
	if _, err := d.Dispatch(context.Background(), b); err == nil {
		t.Fatal("no error")
	}
	if len(s.calls) != 0 || l.Left("rt_1") != 30 {
		t.Error("a refused brief used a fire")
	}
}

func TestSteerCancelUsageAndCaps(t *testing.T) {
	c := newClock()
	d := newDispatcher(t, &server{}, c, NewLimiter(c.Now), "rt_1")
	if err := d.Steer(context.Background(), api.Session{}, "x"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("steer %v", err)
	}
	if err := d.Cancel(context.Background(), api.Session{}); !errors.Is(err, ErrUnsupported) {
		t.Errorf("cancel %v", err)
	}
	if u, err := d.Usage(context.Background(), api.Session{}); err != nil || u != (api.Usage{}) {
		t.Errorf("usage %+v %v", u, err)
	}
	if caps := d.Caps(); caps.FiresPerHour != 30 || !caps.Remote || caps.CanPushWorkflows {
		t.Errorf("caps %+v", caps)
	}
	if d.Name() != "fire" {
		t.Error(d.Name())
	}
}

func TestNoProviderVariablesInRequests(t *testing.T) {
	c := newClock()
	s := &server{}
	d := newDispatcher(t, s, c, NewLimiter(c.Now), "rt_1")
	_, _ = d.Dispatch(context.Background(), bf)
	all := strings.ToUpper(strings.Join(append(append(s.calls, s.body...), s.auth...), "\n"))
	if strings.Contains(all, "ANTHROPIC_") {
		t.Errorf("request carries a provider variable: %s", all)
	}
}

var _ api.Dispatcher = (*Dispatcher)(nil)
