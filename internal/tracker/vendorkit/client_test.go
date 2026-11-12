package vendorkit_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/tracker/vendorkit"
)

func newClient(sleeps *[]time.Duration) *vendorkit.Client {
	return &vendorkit.Client{
		Timeout:    time.Second,
		MaxRetries: 2,
		Base:       100 * time.Millisecond,
		Sleep:      func(_ context.Context, d time.Duration) error { *sleeps = append(*sleeps, d); return nil },
		Jitter:     func(d time.Duration) time.Duration { return d / 2 },
	}
}

// Symphony §8.4: retries are bounded with backoff; only 429, 5xx and transport errors retry.
func TestDoRetryRules(t *testing.T) {
	cases := []struct {
		name      string
		statuses  []int
		wantCalls int32
		wantErr   bool
		wantCode  int
	}{
		{"429 then 200 retries once", []int{429, 200}, 2, false, 0},
		{"403 is not retried", []int{403, 200}, 1, true, 403},
		{"404 is not retried", []int{404}, 1, true, 404},
		{"500 then 200 retries", []int{500, 200}, 2, false, 0},
		{"429 forever stops at the bound", []int{429, 429, 429, 429}, 3, true, 429},
		{"200 first call", []int{200}, 1, false, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				i := int(calls.Add(1)) - 1
				w.WriteHeader(c.statuses[min(i, len(c.statuses)-1)])
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer srv.Close()
			var sleeps []time.Duration
			body, err := newClient(&sleeps).Do(context.Background(), "POST", srv.URL+"/x?secret=1", nil, []byte(`{}`))
			if calls.Load() != c.wantCalls {
				t.Fatalf("calls = %d, want %d", calls.Load(), c.wantCalls)
			}
			if c.wantErr {
				var se *vendorkit.StatusError
				if !errors.As(err, &se) || se.Status != c.wantCode {
					t.Fatalf("err = %v, want StatusError %d", err, c.wantCode)
				}
				if strings.Contains(err.Error(), "secret=1") {
					t.Fatalf("error leaks the query: %v", err)
				}
				return
			}
			if err != nil || string(body) != `{"ok":true}` {
				t.Fatalf("body %q err %v", body, err)
			}
		})
	}
}

func TestDoBackoffGrowsWithJitter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
	defer srv.Close()
	var sleeps []time.Duration
	_, _ = newClient(&sleeps).Do(context.Background(), "GET", srv.URL, nil, nil)
	want := []time.Duration{150 * time.Millisecond, 300 * time.Millisecond}
	if len(sleeps) != 2 || sleeps[0] != want[0] || sleeps[1] != want[1] {
		t.Fatalf("sleeps = %v, want %v", sleeps, want)
	}
}

func TestDoRetryAfterHeader(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(429)
			return
		}
	}))
	defer srv.Close()
	var sleeps []time.Duration
	if _, err := newClient(&sleeps).Do(context.Background(), "GET", srv.URL, nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(sleeps) != 1 || sleeps[0] < 2*time.Second {
		t.Fatalf("sleeps = %v, want at least the 2s Retry-After", sleeps)
	}
}

func TestDoTimesOutEachAttempt(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		<-r.Context().Done()
	}))
	defer srv.Close()
	var sleeps []time.Duration
	c := newClient(&sleeps)
	c.Timeout = 20 * time.Millisecond
	c.MaxRetries = 1
	if _, err := c.Do(context.Background(), "GET", srv.URL, nil, nil); err == nil {
		t.Fatal("want a timeout error")
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2 (one retry after the timeout)", calls.Load())
	}
}

func TestDoStopsWhenContextEnds(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	var sleeps []time.Duration
	c := newClient(&sleeps)
	c.Sleep = func(context.Context, time.Duration) error { cancel(); return ctx.Err() }
	if _, err := c.Do(ctx, "GET", srv.URL, nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}
