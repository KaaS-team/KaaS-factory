package serve

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

type memStore map[string]time.Time

func (m memStore) Last(n string) (time.Time, bool) { t, ok := m[n]; return t, ok }
func (m memStore) Set(n string, t time.Time) error { m[n] = t; return nil }

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func run(t *testing.T, s Schedule, last, now time.Time, instance string) []Occurrence {
	t.Helper()
	var got []Occurrence
	sc := &Scheduler{Schedules: []Schedule{s}, Store: memStore{s.Name: last}, Instance: instance,
		Fire: func(_ context.Context, o Occurrence) error { got = append(got, o); return nil }}
	if err := sc.Tick(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	return got
}

// Symphony 8.1 (the poll loop is the clock): a restart after 6h of downtime fires an hourly schedule once.
func TestCatchUpFiresLatestMissedOnly(t *testing.T) {
	hourly := Schedule{Name: "h", Spec: "0 * * * *"}
	last := at("2026-03-01T06:00:00Z")
	tests := []struct {
		name    string
		now     string
		want    int
		nominal string
		skipped bool
	}{
		{"not yet due", "2026-03-01T06:59:00Z", 0, "", false},
		{"one tick due", "2026-03-01T07:00:40Z", 1, "2026-03-01T07:00:00Z", false},
		{"six hours down", "2026-03-01T12:10:00Z", 1, "2026-03-01T12:00:00Z", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := run(t, hourly, last, at(tt.now), "")
			if len(got) != tt.want {
				t.Fatalf("fired %d times, want %d", len(got), tt.want)
			}
			if tt.want == 1 && (!got[0].Nominal.Equal(at(tt.nominal)) || got[0].Skipped != tt.skipped) {
				t.Fatalf("got %+v", got[0])
			}
		})
	}
}

func TestTickTwiceFiresOnce(t *testing.T) {
	var n int
	st := memStore{"h": at("2026-03-01T06:00:00Z")}
	sc := &Scheduler{Schedules: []Schedule{{Name: "h", Spec: "0 * * * *"}}, Store: st,
		Fire: func(context.Context, Occurrence) error { n++; return nil }}
	now := at("2026-03-01T12:10:00Z")
	for i := 0; i < 2; i++ {
		if err := sc.Tick(context.Background(), now); err != nil {
			t.Fatal(err)
		}
	}
	if n != 1 {
		t.Fatalf("fired %d times", n)
	}
}

func TestFirstSightStartsFromNow(t *testing.T) {
	var n int
	st := memStore{}
	sc := &Scheduler{Schedules: []Schedule{{Name: "h", Spec: "0 * * * *"}}, Store: st,
		Fire: func(context.Context, Occurrence) error { n++; return nil }}
	if err := sc.Tick(context.Background(), at("2026-03-01T12:10:00Z")); err != nil || n != 0 || !st["h"].Equal(at("2026-03-01T12:10:00Z")) {
		t.Fatalf("err %v fired %d store %v", err, n, st)
	}
}

func TestFireFailureStaysDue(t *testing.T) {
	st := memStore{"h": at("2026-03-01T06:00:00Z")}
	sc := &Scheduler{Schedules: []Schedule{{Name: "h", Spec: "0 * * * *"}}, Store: st,
		Fire: func(context.Context, Occurrence) error { return fmt.Errorf("boom") }}
	if err := sc.Tick(context.Background(), at("2026-03-01T07:01:00Z")); err == nil {
		t.Fatal("want the fire error")
	}
	if !st["h"].Equal(at("2026-03-01T06:00:00Z")) {
		t.Fatalf("store advanced to %v", st["h"])
	}
}

// Timezone and DST: a daily 09:00 in New York is 14:00Z in winter and 13:00Z after the March 8 2026 change.
func TestZoneAndDST(t *testing.T) {
	daily := Schedule{Name: "d", Spec: "0 9 * * *", Zone: "America/New_York"}
	tests := []struct{ name, last, now, nominal string }{
		{"winter", "2026-03-06T14:00:00Z", "2026-03-07T14:00:30Z", "2026-03-07T14:00:00Z"},
		{"day of change", "2026-03-07T14:00:00Z", "2026-03-08T13:00:30Z", "2026-03-08T13:00:00Z"},
		{"summer", "2026-03-08T13:00:00Z", "2026-03-09T13:00:30Z", "2026-03-09T13:00:00Z"},
		{"fall back", "2026-10-31T13:00:00Z", "2026-11-01T14:00:30Z", "2026-11-01T14:00:00Z"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := run(t, daily, at(tt.last), at(tt.now), "")
			if len(got) != 1 || !got[0].Nominal.Equal(at(tt.nominal)) {
				t.Fatalf("got %+v, want %s", got, tt.nominal)
			}
		})
	}
	// The spring-forward gap: 02:30 does not exist on 2026-03-08 in New York, so that day has no tick
	// (robfig/cron skips it); the next day fires normally.
	gap := Schedule{Name: "g", Spec: "30 2 * * *", Zone: "America/New_York"}
	if got := run(t, gap, at("2026-03-07T07:30:00Z"), at("2026-03-08T12:00:00Z"), ""); len(got) != 0 {
		t.Fatalf("gap day fired: %+v", got)
	}
	if got := run(t, gap, at("2026-03-07T07:30:00Z"), at("2026-03-09T07:00:00Z"), ""); len(got) != 1 || !got[0].Nominal.Equal(at("2026-03-09T06:30:00Z")) {
		t.Fatalf("day after the gap: %+v", got)
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name string
		s    Schedule
		bad  bool
	}{
		{"ok", Schedule{Name: "a", Spec: "0 6 * * 1"}, false},
		{"bad spec", Schedule{Name: "a", Spec: "nope"}, true},
		{"bad zone", Schedule{Name: "a", Spec: "0 6 * * 1", Zone: "Mars/Base"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := (&Scheduler{Schedules: []Schedule{tt.s}}).Validate()
			if (err != nil) != tt.bad {
				t.Fatalf("err %v", err)
			}
		})
	}
}

// 50 teammates on the same minute start spread over the window, deterministically, never after the tick.
func TestJitterSpreadsTeammates(t *testing.T) {
	nominal := at("2026-03-01T09:00:00Z")
	window := 30 * time.Second
	buckets := map[int]bool{}
	for i := 0; i < 50; i++ {
		id := fmt.Sprintf("mate-%d", i)
		d := JitterOffset(nominal, window, id)
		if d < 0 || d > window {
			t.Fatalf("%s offset %v outside the window", id, d)
		}
		if d != JitterOffset(nominal, window, id) {
			t.Fatalf("%s offset is not deterministic", id)
		}
		buckets[int(d/time.Second)] = true
	}
	if len(buckets) < 15 {
		t.Fatalf("50 teammates landed in %d of 30 seconds", len(buckets))
	}
	if JitterOffset(nominal, 0, "x") != 0 {
		t.Fatal("zero window must give zero offset")
	}
}

// A jittered start can come before its tick: it is due once now reaches tick minus offset.
func TestJitterMakesTickDueEarly(t *testing.T) {
	nominal := at("2026-03-01T09:00:00Z")
	off := JitterOffset(nominal, DefaultJitterWindow, "me")
	if off == 0 {
		t.Skip("offset is zero for this seed")
	}
	s := Schedule{Name: "h", Spec: "0 * * * *"}
	last := at("2026-03-01T08:00:00Z")
	if got := run(t, s, last, nominal.Add(-off-time.Second), "me"); len(got) != 0 {
		t.Fatalf("fired before its jittered start: %+v", got)
	}
	if got := run(t, s, last, nominal.Add(-off), "me"); len(got) != 1 {
		t.Fatalf("did not fire at its jittered start: %+v", got)
	}
}

func TestFileStoreRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "schedules.json")
	f, err := OpenFileStore(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := f.Last("a"); ok {
		t.Fatal("empty store has a value")
	}
	if err := f.Set("a", at("2026-03-01T07:00:00Z")); err != nil {
		t.Fatal(err)
	}
	g, err := OpenFileStore(p)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := g.Last("a"); !ok || !got.Equal(at("2026-03-01T07:00:00Z")) {
		t.Fatalf("got %v %v", got, ok)
	}
}
