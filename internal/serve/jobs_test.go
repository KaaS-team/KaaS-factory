package serve

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func openJobs(t *testing.T, path string, clk Clock) (*Jobs, *bytes.Buffer) {
	t.Helper()
	if path == "" {
		path = filepath.Join(t.TempDir(), "jobs.db")
	}
	var buf bytes.Buffer
	var mu sync.Mutex
	j, err := OpenJobs(path, clk, func(f string, a ...any) { mu.Lock(); fmt.Fprintf(&buf, f+"\n", a...); mu.Unlock() })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = j.Close() })
	return j, &buf
}

func runCount(t *testing.T, j *Jobs, job string) int {
	t.Helper()
	h, err := j.History(context.Background(), job)
	if err != nil {
		t.Fatal(err)
	}
	return len(h)
}

// Symphony 8.1: the poll tick fires due work; here a cron job fires once per period.
func TestJobs_TickFiresDueJobOncePerPeriod_Symphony8_1(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Date(2026, 1, 1, 10, 0, 30, 0, time.UTC)}
	j, _ := openJobs(t, "", clk)
	if err := j.Add(ctx, "a", "*/5 * * * *"); err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		add  time.Duration
		want int
	}{{time.Minute, 0}, {4 * time.Minute, 1}, {time.Minute, 1}, {5 * time.Minute, 2}} {
		clk.Add(step.add)
		if err := j.Tick(ctx); err != nil {
			t.Fatal(err)
		}
		if got := runCount(t, j, "a"); got != step.want {
			t.Fatalf("after +%s: %d runs, want %d", step.add, got, step.want)
		}
	}
}

func TestJobs_PauseUnpause(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)}
	j, _ := openJobs(t, "", clk)
	_ = j.Add(ctx, "a", "* * * * *")
	if err := j.Pause(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	clk.Add(3 * time.Minute)
	_ = j.Tick(ctx)
	if n := runCount(t, j, "a"); n != 0 {
		t.Fatalf("paused job fired %d runs", n)
	}
	if err := j.Unpause(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	clk.Add(time.Minute)
	_ = j.Tick(ctx)
	if n := runCount(t, j, "a"); n != 1 {
		t.Fatalf("unpaused job fired %d runs, want 1 (no catch-up of the paused minutes)", n)
	}
	if h, _ := j.History(ctx, "a"); h[0].Period != clk.Now().Unix() {
		t.Fatalf("period = %d, want the current minute %d", h[0].Period, clk.Now().Unix())
	}
	if err := j.Pause(ctx, "nope"); !errors.Is(err, ErrNoJob) {
		t.Fatalf("pause unknown = %v", err)
	}
}

func TestJobs_RunNowQueuesImmediatelyEvenWhenPaused(t *testing.T) {
	ctx := context.Background()
	j, _ := openJobs(t, "", &fakeClock{t: time.Unix(1_000_000, 0)})
	_ = j.Add(ctx, "a", "0 0 1 1 *")
	_ = j.Pause(ctx, "a")
	for range 2 {
		if err := j.RunNow(ctx, "a"); err != nil {
			t.Fatal(err)
		}
	}
	if n := runCount(t, j, "a"); n != 2 {
		t.Fatalf("run_now made %d runs, want 2", n)
	}
	if err := j.RunNow(ctx, "nope"); !errors.Is(err, ErrNoJob) {
		t.Fatalf("run_now unknown = %v", err)
	}
}

func TestJobs_UpdateCron(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)}
	j, _ := openJobs(t, "", clk)
	_ = j.Add(ctx, "a", "0 0 1 1 *")
	clk.Add(time.Minute)
	_ = j.Tick(ctx)
	if n := runCount(t, j, "a"); n != 0 {
		t.Fatalf("yearly job fired")
	}
	if err := j.SetCron(ctx, "a", "not a cron"); err == nil {
		t.Fatal("bad cron accepted")
	}
	if err := j.SetCron(ctx, "a", "* * * * *"); err != nil {
		t.Fatal(err)
	}
	clk.Add(time.Minute)
	_ = j.Tick(ctx)
	if n := runCount(t, j, "a"); n != 1 {
		t.Fatalf("updated cron fired %d, want 1", n)
	}
}

func TestJobs_KillCancelsRunningRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	j, _ := openJobs(t, "", clk)
	_ = j.Add(ctx, "a", "0 0 1 1 *")
	_ = j.RunNow(ctx, "a")
	started := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = j.runOne(ctx, func(c context.Context, _ Run) error {
			close(started)
			<-c.Done()
			return c.Err()
		})
	}()
	<-started
	if err := j.Kill(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	<-done
	h, _ := j.History(ctx, "a")
	if len(h) != 1 || h[0].Status != StatusKilled {
		t.Fatalf("history = %+v, want one killed run", h)
	}
	if err := j.Kill(ctx, "a"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("kill idle job = %v", err)
	}
}

func TestJobs_HistoryRecordsOutcomes(t *testing.T) {
	ctx := context.Background()
	j, _ := openJobs(t, "", &fakeClock{t: time.Unix(1_000_000, 0)})
	_ = j.Add(ctx, "a", "0 0 1 1 *")
	_ = j.RunNow(ctx, "a")
	if _, err := j.runOne(ctx, func(context.Context, Run) error { return nil }); err != nil {
		t.Fatal(err)
	}
	h, _ := j.History(ctx, "a")
	if len(h) != 1 || h[0].Status != StatusOK || h[0].Attempt != 1 || h[0].FinishedAt.IsZero() {
		t.Fatalf("history = %+v", h)
	}
}

// A corrupt job is skipped with a logged reason; the others still load and fire.
func TestJobs_CorruptJobSkippedAtLoad(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)}
	j, logs := openJobs(t, "", clk)
	_ = j.Add(ctx, "good", "* * * * *")
	for _, row := range [][2]any{{"bad-cron", "banana"}, {"empty", ""}, {"null", nil}} {
		if _, err := j.db.Exec(`INSERT INTO jobs (id, cron, paused, cursor) VALUES (?, ?, 0, 0)`, row[0], row[1]); err != nil {
			t.Fatal(err)
		}
	}
	jobs, err := j.Load(ctx)
	if err != nil || len(jobs) != 1 || jobs[0].ID != "good" {
		t.Fatalf("load = %+v, %v", jobs, err)
	}
	for _, id := range []string{"bad-cron", "empty", "null"} {
		if !strings.Contains(logs.String(), "job "+id+" skipped: ") {
			t.Fatalf("no skip reason for %s in %q", id, logs)
		}
	}
	clk.Add(time.Minute)
	if err := j.Tick(ctx); err != nil {
		t.Fatalf("tick with corrupt jobs: %v", err)
	}
	if n := runCount(t, j, "good"); n != 1 {
		t.Fatalf("good job fired %d", n)
	}
}

// Cron accepts 5 fields and 6 fields (leading seconds), like the upstream scheduler.
func TestJobs_CronFieldCounts(t *testing.T) {
	for spec, ok := range map[string]bool{"* * * * *": true, "*/10 * * * * *": true, "@hourly": true, "* * *": false, "": false} {
		if err := validCron(spec); (err == nil) != ok {
			t.Errorf("validCron(%q) = %v, want ok=%v", spec, err, ok)
		}
	}
}

// River claim semantics: backoff is attempt^4 seconds with 10% jitter, capped.
func TestBackoff(t *testing.T) {
	for _, c := range []struct {
		attempt int
		jitter  float64 // rnd result in [0,1)
		want    time.Duration
	}{
		{1, 0.5, time.Second},
		{2, 0.5, 16 * time.Second},
		{3, 0, 81 * time.Second * 9 / 10},
		{3, 1, 81 * time.Second * 11 / 10},
		{20, 0.5, maxBackoff},
		{0, 0.5, time.Second},
	} {
		got := backoff(c.attempt, func() float64 { return c.jitter })
		inBand := c.want == maxBackoff && got <= maxBackoff*11/10 && got >= maxBackoff*9/10
		if got != c.want && !inBand {
			t.Errorf("backoff(%d,%v) = %s, want %s", c.attempt, c.jitter, got, c.want)
		}
	}
}

func TestJobs_FailureRetriesWithBackoffThenFails(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	j, _ := openJobs(t, "", clk)
	j.maxAttempts = 2
	_ = j.Add(ctx, "a", "0 0 1 1 *")
	_ = j.RunNow(ctx, "a")
	boom := func(context.Context, Run) error { return errors.New("boom") }
	if ok, _ := j.runOne(ctx, boom); !ok {
		t.Fatal("first claim missed")
	}
	if ok, _ := j.runOne(ctx, boom); ok {
		t.Fatal("run claimed again before its backoff passed")
	}
	clk.Add(time.Minute)
	if ok, _ := j.runOne(ctx, boom); !ok {
		t.Fatal("run not retried after backoff")
	}
	h, _ := j.History(ctx, "a")
	if len(h) != 1 || h[0].Status != StatusFailed || h[0].Attempt != 2 || h[0].Error != "boom" {
		t.Fatalf("history = %+v", h)
	}
	clk.Add(time.Hour)
	if ok, _ := j.runOne(ctx, boom); ok {
		t.Fatal("failed run claimed again")
	}
}

func TestJobs_SnoozeDoesNotCountAsAttempt(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	j, _ := openJobs(t, "", clk)
	j.maxAttempts = 1
	_ = j.Add(ctx, "a", "0 0 1 1 *")
	_ = j.RunNow(ctx, "a")
	snooze := func(context.Context, Run) error { return Snooze{After: time.Minute} }
	for range 3 {
		if ok, _ := j.runOne(ctx, snooze); !ok {
			t.Fatal("snoozed run not claimed when due")
		}
		clk.Add(time.Minute)
	}
	h, _ := j.History(ctx, "a")
	if h[0].Status != StatusQueued || h[0].Attempt != 0 {
		t.Fatalf("after 3 snoozes: %+v, want queued with 0 attempts", h[0])
	}
	if _, err := j.runOne(ctx, func(context.Context, Run) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if h, _ = j.History(ctx, "a"); h[0].Status != StatusOK || h[0].Attempt != 1 {
		t.Fatalf("final = %+v", h[0])
	}
}

// A crash leaves a running row; after the timeout it is queued again.
func TestJobs_StuckRunningRowRequeuedAfterTimeout(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	path := filepath.Join(t.TempDir(), "jobs.db")
	j1, _ := openJobs(t, path, clk)
	_ = j1.Add(ctx, "a", "0 0 1 1 *")
	_ = j1.RunNow(ctx, "a")
	if _, ok, err := j1.claim(ctx); err != nil || !ok { // the daemon dies here, run never finished
		t.Fatalf("claim = %v %v", ok, err)
	}
	_ = j1.Close()

	j2, _ := openJobs(t, path, clk)
	if n, _ := j2.Requeue(ctx); n != 0 {
		t.Fatalf("requeued %d before the timeout", n)
	}
	clk.Add(j2.runTimeout + time.Second)
	if n, err := j2.Requeue(ctx); err != nil || n != 1 {
		t.Fatalf("requeued %d, %v; want 1", n, err)
	}
	if ok, _ := j2.runOne(ctx, func(context.Context, Run) error { return nil }); !ok {
		t.Fatal("requeued run not claimable")
	}
	if h, _ := j2.History(ctx, "a"); h[0].Status != StatusOK || h[0].Attempt != 2 {
		t.Fatalf("history = %+v", h)
	}
}

// Two daemons share one database; claiming is one statement, so each run goes to exactly one.
func TestJobs_ClaimIsExclusive(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	path := filepath.Join(t.TempDir(), "jobs.db")
	a, _ := openJobs(t, path, clk)
	b, _ := openJobs(t, path, clk)
	_ = a.Add(ctx, "j", "0 0 1 1 *")
	for range 20 {
		_ = a.RunNow(ctx, "j")
	}
	var mu sync.Mutex
	got := map[int64]int{}
	var wg sync.WaitGroup
	for _, d := range []*Jobs{a, b, a, b} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				r, ok, err := d.claim(ctx)
				if err != nil {
					t.Error(err)
					return
				}
				if !ok {
					return
				}
				mu.Lock()
				got[r.ID]++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(got) != 20 {
		t.Fatalf("claimed %d distinct runs, want 20", len(got))
	}
	for id, n := range got {
		if n != 1 {
			t.Fatalf("run %d claimed %d times", id, n)
		}
	}
}

func TestJobs_OnlyLeaderFiresTicksAndFailsOver(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)}
	path := filepath.Join(t.TempDir(), "jobs.db")
	a, _ := openJobs(t, path, clk)
	b, _ := openJobs(t, path, clk)
	a.holder, b.holder = "a", "b"
	_ = a.Add(ctx, "j", "* * * * *")

	la, _ := a.Lead(ctx)
	lb, _ := b.Lead(ctx)
	if !la || lb {
		t.Fatalf("leaders = a:%v b:%v, want only a", la, lb)
	}
	clk.Add(time.Minute)
	_, _ = a.Lead(ctx) // a renews, so the minute passing does not free the lease
	_ = b.TickIfLeader(ctx)
	if n := runCount(t, a, "j"); n != 0 {
		t.Fatalf("follower fired %d ticks", n)
	}
	_ = a.TickIfLeader(ctx)
	if n := runCount(t, a, "j"); n != 1 {
		t.Fatalf("leader fired %d ticks, want 1", n)
	}

	// a stops renewing; before the TTL ends b is still a follower, after it b takes over.
	clk.Add(a.leaseTTL - time.Second)
	if lb, _ = b.Lead(ctx); lb {
		t.Fatal("b took over inside the TTL window")
	}
	clk.Add(2 * time.Second)
	if lb, _ = b.Lead(ctx); !lb {
		t.Fatal("b did not take over after the TTL")
	}
	if la, _ = a.Lead(ctx); la {
		t.Fatal("a regained leadership while b holds it")
	}
}

func TestJobs_PeriodKeyedInsertPreventsDoubleTick(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)}
	j, _ := openJobs(t, "", clk)
	_ = j.Add(ctx, "j", "* * * * *")
	clk.Add(time.Minute)
	_ = j.Tick(ctx)
	if _, err := j.db.Exec(`UPDATE jobs SET cursor = ?`, clk.Now().Add(-time.Minute).UnixNano()); err != nil { // a second daemon with a stale cursor
		t.Fatal(err)
	}
	_ = j.Tick(ctx)
	if n := runCount(t, j, "j"); n != 1 {
		t.Fatalf("%d runs for one period, want 1", n)
	}
}

func TestLeaseJitterStaysInBand(t *testing.T) {
	ttl := 30 * time.Second
	for _, r := range []float64{0, 0.5, 0.999} {
		d := renewDelay(ttl, func() float64 { return r })
		if d < ttl/4 || d > ttl/3+ttl/12 {
			t.Errorf("renewDelay(r=%v) = %s outside [ttl/4, 5ttl/12]", r, d)
		}
	}
}

// The scheduler loop runs from Serve: a queued run is executed and recorded.
func TestServe_RunsJobs(t *testing.T) {
	ctx := context.Background()
	j, _ := openJobs(t, "", nil)
	_ = j.Add(ctx, "a", "0 0 1 1 *")
	_ = j.RunNow(ctx, "a")
	ran := make(chan string, 1)
	s := New(newFakeCore(), Options{Interval: time.Second, Clock: &fakeClock{}, Jobs: j,
		Exec: func(_ context.Context, r Run) error { ran <- r.Job; return nil }})
	cancel, done := startServe(t, s, time.Second)
	defer func() { cancel(); <-done }()
	select {
	case got := <-ran:
		if got != "a" {
			t.Fatalf("ran %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("job never ran")
	}
}

// A run that keeps timing out is failed once it has used its attempts, not requeued forever.
func TestJobs_StuckRunOutOfAttemptsFails(t *testing.T) {
	ctx := context.Background()
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	j, _ := openJobs(t, "", clk)
	j.maxAttempts = 1
	_ = j.Add(ctx, "a", "0 0 1 1 *")
	_ = j.RunNow(ctx, "a")
	if _, ok, _ := j.claim(ctx); !ok {
		t.Fatal("no claim")
	}
	clk.Add(j.runTimeout + time.Second)
	if n, _ := j.Requeue(ctx); n != 0 {
		t.Fatalf("requeued %d, want 0", n)
	}
	if h, _ := j.History(ctx, "a"); h[0].Status != StatusFailed || h[0].Error != "timed out" {
		t.Fatalf("history = %+v", h)
	}
}

// The controls are reachable over HTTP from the served handler, and Serve opens the database itself.
func TestServe_JobControlsOverHTTP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	block := make(chan struct{})
	started := make(chan struct{}, 1)
	s := New(newFakeCore(), Options{Interval: 50 * time.Millisecond, JobsPath: path,
		Exec: func(ctx context.Context, _ Run) error {
			started <- struct{}{}
			select {
			case <-block:
			case <-ctx.Done():
			}
			return ctx.Err()
		}})
	addr := make(chan string, 1)
	s.onListen = func(a string) { addr <- a }
	cancel, done := startServe(t, s, time.Second)
	defer func() { cancel(); <-done }()
	base := "http://" + <-addr
	do := func(method, p, body string) (int, string) {
		req, _ := http.NewRequest(method, base+p, strings.NewReader(body))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	for _, c := range []struct {
		method, path, body string
		want               int
	}{
		{"PUT", "/jobs/a", "bogus", 400},
		{"PUT", "/jobs/a", "0 0 1 1 *", 204},
		{"POST", "/jobs/a/pause", "", 204},
		{"POST", "/jobs/a/unpause", "", 204},
		{"PUT", "/jobs/a/cron", "*/5 * * * *", 204},
		{"PUT", "/jobs/a/cron", "bogus", 400},
		{"POST", "/jobs/zzz/pause", "", 404},
		{"POST", "/jobs/a/kill", "", 409},
		{"POST", "/jobs/a/nope", "", 404},
		{"POST", "/jobs/a/run", "", 204},
	} {
		if got, body := do(c.method, c.path, c.body); got != c.want {
			t.Fatalf("%s %s = %d (%s), want %d", c.method, c.path, got, body, c.want)
		}
	}
	<-started
	if got, _ := do("POST", "/jobs/a/kill", ""); got != 204 {
		t.Fatalf("kill running = %d", got)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, body := do("GET", "/jobs/a/runs", "")
		if strings.Contains(body, `"status":"killed"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("history never showed a killed run: %s", body)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
