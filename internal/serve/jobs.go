package serve

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	mrand "math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
	_ "modernc.org/sqlite" // pure Go driver, registers "sqlite"
)

// Run statuses. A run is queued until claimed, running while an executor holds it, then ok, failed
// or killed.
const (
	StatusQueued = "queued"
	StatusOK     = "ok"
	StatusFailed = "failed"
	StatusKilled = "killed"
	statusRun    = "running"
)

const (
	maxBackoff         = 24 * time.Hour
	defaultMaxAttempts = 25
	defaultRunTimeout  = time.Hour
	defaultLeaseTTL    = 30 * time.Second
	maxCatchUp         = 10000 // cron steps walked per tick before giving up on counting missed periods
)

// ErrNoJob is returned when a control names a job that does not exist.
var ErrNoJob = errors.New("no such job")

// ErrNotRunning is returned by Kill when the job has no running run.
var ErrNotRunning = errors.New("job has no running run")

// Snooze is an executor result that puts the run back in the queue after a delay without counting
// an attempt.
type Snooze struct{ After time.Duration }

func (s Snooze) Error() string { return fmt.Sprintf("snoozed for %s", s.After) }

// Executor does the work of one run. Its context ends when the run is killed or the daemon stops.
type Executor func(ctx context.Context, r Run) error

// Job is a scheduled job that loaded cleanly.
type Job struct {
	ID     string
	Cron   string
	Paused bool
	cursor time.Time
	sched  cron.Schedule
}

// Run is one queued or finished execution of a job, and one row of its history.
type Run struct {
	ID         int64     `json:"id"`
	Job        string    `json:"job"`
	Period     int64     `json:"period"` // the cron period it fires for (unix seconds); negative for run_now
	Status     string    `json:"status"`
	Attempt    int       `json:"attempt"`
	RunAt      time.Time `json:"run_at"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	Error      string    `json:"error,omitempty"`
}

// Jobs is the SQLite-backed job table, run queue and leader lease behind the scheduler.
type Jobs struct {
	db          *sql.DB
	clock       Clock
	logf        func(format string, args ...any)
	rnd         func() float64
	holder      string
	leaseTTL    time.Duration
	runTimeout  time.Duration
	maxAttempts int
	jitter      time.Duration // see SetJitter
	instance    string
	mu          sync.Mutex
	cancels     map[int64]context.CancelFunc
}

const jobsSchema = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, cron TEXT, paused INTEGER, cursor INTEGER);
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, period INTEGER NOT NULL,
  status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, run_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL DEFAULT 0, finished_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
  UNIQUE (job, period));
CREATE INDEX IF NOT EXISTS job_runs_claim ON job_runs (status, run_at);
CREATE TABLE IF NOT EXISTS leader (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires INTEGER NOT NULL);
`

// OpenJobs opens or creates the job database at path. A nil clock means the wall clock; logf
// receives one line per skipped job and may be nil.
func OpenJobs(path string, clk Clock, logf func(string, ...any)) (*Jobs, error) {
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_txlock", "immediate")
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(jobsSchema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create jobs schema: %w", err)
	}
	if clk == nil {
		clk = realClock{}
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	var id [8]byte
	_, _ = rand.Read(id[:])
	return &Jobs{db: db, clock: clk, logf: logf, rnd: mrand.Float64, holder: hex.EncodeToString(id[:]),
		leaseTTL: defaultLeaseTTL, runTimeout: defaultRunTimeout, maxAttempts: defaultMaxAttempts,
		cancels: map[int64]context.CancelFunc{}}, nil
}

// Close closes the database.
func (j *Jobs) Close() error { return j.db.Close() }

func (j *Jobs) now() int64 { return j.clock.Now().UnixNano() }

var cronParser = cron.NewParser(cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

// validCron accepts 5 fields, 6 fields with leading seconds, and @descriptors.
func validCron(spec string) error {
	_, err := cronParser.Parse(spec)
	return err
}

// Add creates a job, or replaces the cron of an existing one. It fails on a bad cron.
func (j *Jobs) Add(ctx context.Context, id, spec string) error {
	if err := validCron(spec); err != nil {
		return fmt.Errorf("job %s: %w", id, err)
	}
	_, err := j.db.ExecContext(ctx, `INSERT INTO jobs (id, cron, paused, cursor) VALUES (?, ?, 0, ?)
ON CONFLICT (id) DO UPDATE SET cron=excluded.cron, cursor=excluded.cursor`, id, spec, j.now())
	return err
}

func (j *Jobs) exec(ctx context.Context, id, query string, args ...any) error {
	res, err := j.db.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("%w: %s", ErrNoJob, id)
	}
	return nil
}

// Pause stops a job from firing on its cron. Queued and running runs are untouched.
func (j *Jobs) Pause(ctx context.Context, id string) error {
	return j.exec(ctx, id, `UPDATE jobs SET paused=1 WHERE id=?`, id)
}

// Unpause lets a job fire again from now; periods missed while paused are not made up.
func (j *Jobs) Unpause(ctx context.Context, id string) error {
	return j.exec(ctx, id, `UPDATE jobs SET paused=0, cursor=? WHERE id=?`, j.now(), id)
}

// SetCron replaces a job's schedule, taking effect from now. It fails on a bad cron.
func (j *Jobs) SetCron(ctx context.Context, id, spec string) error {
	if err := validCron(spec); err != nil {
		return fmt.Errorf("job %s: %w", id, err)
	}
	return j.exec(ctx, id, `UPDATE jobs SET cron=?, cursor=? WHERE id=?`, spec, j.now(), id)
}

// RunNow queues a run immediately, paused or not.
func (j *Jobs) RunNow(ctx context.Context, id string) error {
	var one int
	if err := j.db.QueryRowContext(ctx, `SELECT 1 FROM jobs WHERE id=?`, id).Scan(&one); errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: %s", ErrNoJob, id)
	} else if err != nil {
		return err
	}
	_, err := j.db.ExecContext(ctx, `INSERT INTO job_runs (job, period, status, run_at) VALUES (?, -(SELECT COALESCE(MAX(id), 0) + 1 FROM job_runs), 'queued', ?)`, id, j.now())
	return err
}

// Kill marks the job's running run killed and cancels its executor's context.
func (j *Jobs) Kill(ctx context.Context, id string) error {
	rows, err := j.db.QueryContext(ctx, `UPDATE job_runs SET status='killed', finished_at=? WHERE job=? AND status='running' RETURNING id`, j.now(), id)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var n int64
		if err := rows.Scan(&n); err != nil {
			_ = rows.Close()
			return err
		}
		ids = append(ids, n)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(ids) == 0 {
		return fmt.Errorf("%w: %s", ErrNotRunning, id)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, n := range ids {
		if c := j.cancels[n]; c != nil {
			c()
		}
	}
	return nil
}

// History returns every run of a job, oldest first.
func (j *Jobs) History(ctx context.Context, id string) ([]Run, error) {
	rows, err := j.db.QueryContext(ctx, `SELECT id, job, period, status, attempt, run_at, started_at, finished_at, error
FROM job_runs WHERE job=? ORDER BY id`, id)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Run
	for rows.Next() {
		out = append(out, scanRun(rows))
	}
	return out, rows.Err()
}

func scanRun(s interface{ Scan(...any) error }) Run {
	var r Run
	var runAt, started, finished int64
	if err := s.Scan(&r.ID, &r.Job, &r.Period, &r.Status, &r.Attempt, &runAt, &started, &finished, &r.Error); err != nil {
		return Run{}
	}
	r.RunAt, r.StartedAt, r.FinishedAt = fromNanos(runAt), fromNanos(started), fromNanos(finished)
	return r
}

func fromNanos(n int64) time.Time {
	if n == 0 {
		return time.Time{}
	}
	return time.Unix(0, n)
}

// Load returns the jobs that parse. A corrupt row is skipped with one logged reason and stays in
// the table, so it never stops the daemon (Symphony 8.1: a tick must not die on one bad entry).
func (j *Jobs) Load(ctx context.Context) ([]Job, error) {
	rows, err := j.db.QueryContext(ctx, `SELECT id, cron, paused, cursor FROM jobs ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Job
	for rows.Next() {
		var id, spec sql.NullString
		var paused, cursor sql.NullInt64
		if err := rows.Scan(&id, &spec, &paused, &cursor); err != nil {
			j.logf("job skipped: unreadable row: %v", err)
			continue
		}
		if !spec.Valid || spec.String == "" {
			j.logf("job %s skipped: no cron expression", id.String)
			continue
		}
		sched, err := cronParser.Parse(spec.String)
		if err != nil {
			j.logf("job %s skipped: %v", id.String, err)
			continue
		}
		out = append(out, Job{ID: id.String, Cron: spec.String, Paused: paused.Int64 != 0, cursor: time.Unix(0, cursor.Int64), sched: sched})
	}
	return out, rows.Err()
}

// Tick queues one run for each unpaused job whose cron came due since its last tick. The insert is
// keyed by (job, period), so a second daemon ticking the same period adds nothing.
func (j *Jobs) Tick(ctx context.Context) error {
	jobs, err := j.Load(ctx)
	if err != nil {
		return err
	}
	now := j.clock.Now()
	for _, job := range jobs {
		if job.Paused {
			continue
		}
		var due time.Time
		next := job.sched.Next(job.cursor)
		for i := 0; i < maxCatchUp && !next.IsZero() && j.due(next, now); i++ {
			due, next = next, job.sched.Next(next)
		}
		if due.IsZero() {
			continue
		}
		if _, err := j.db.ExecContext(ctx, `INSERT INTO job_runs (job, period, status, run_at) VALUES (?, ?, 'queued', ?)
ON CONFLICT (job, period) DO NOTHING`, job.ID, due.Unix(), now.UnixNano()); err != nil {
			return err
		}
		if _, err := j.db.ExecContext(ctx, `UPDATE jobs SET cursor=? WHERE id=?`, now.UnixNano(), job.ID); err != nil {
			return err
		}
	}
	return nil
}

// Lead takes or renews the leader lease and reports whether this daemon holds it. The lease is
// taken only when free, expired or already ours.
func (j *Jobs) Lead(ctx context.Context) (bool, error) {
	now := j.now()
	res, err := j.db.ExecContext(ctx, `INSERT INTO leader (name, holder, expires) VALUES ('tick', ?, ?)
ON CONFLICT (name) DO UPDATE SET holder=excluded.holder, expires=excluded.expires
WHERE leader.holder=excluded.holder OR leader.expires<=?`, j.holder, now+int64(j.leaseTTL), now)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// TickIfLeader ticks only while this daemon holds the lease.
func (j *Jobs) TickIfLeader(ctx context.Context) error {
	if ok, err := j.Lead(ctx); err != nil || !ok {
		return err
	}
	return j.Tick(ctx)
}

// renewDelay is how long the leader waits before renewing: between a quarter and 5/12 of the TTL.
func renewDelay(ttl time.Duration, rnd func() float64) time.Duration {
	return ttl/4 + time.Duration(rnd()*float64(ttl/6))
}

// backoff is attempt^4 seconds, capped at maxBackoff, with 10% jitter either way.
func backoff(attempt int, rnd func() float64) time.Duration {
	base := time.Second
	if attempt > 1 {
		base = time.Duration(math.Min(math.Pow(float64(attempt), 4), float64(maxBackoff/time.Second))) * time.Second
	}
	return base + base*(time.Duration(rnd()*2000)-1000)/10000
}

// claim takes the oldest due queued run in one statement, so two daemons never get the same run.
func (j *Jobs) claim(ctx context.Context) (Run, bool, error) {
	now := j.now()
	row := j.db.QueryRowContext(ctx, `UPDATE job_runs SET status='running', attempt=attempt+1, started_at=?
WHERE id=(SELECT id FROM job_runs WHERE status='queued' AND run_at<=? ORDER BY run_at, id LIMIT 1)
RETURNING id, job, period, status, attempt, run_at, started_at, finished_at, error`, now, now)
	r := scanRun(row)
	if r.ID == 0 {
		return Run{}, false, nil
	}
	return r, true, nil
}

// Requeue puts runs that have been running past the run timeout back in the queue, or fails them
// when they are out of attempts. It returns how many it put back.
func (j *Jobs) Requeue(ctx context.Context) (int, error) {
	now := j.now()
	cutoff := now - int64(j.runTimeout)
	if _, err := j.db.ExecContext(ctx, `UPDATE job_runs SET status='failed', error='timed out', finished_at=?
WHERE status='running' AND started_at<=? AND attempt>=?`, now, cutoff, j.maxAttempts); err != nil {
		return 0, err
	}
	res, err := j.db.ExecContext(ctx, `UPDATE job_runs SET status='queued', run_at=?, error='timed out'
WHERE status='running' AND started_at<=?`, now, cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// runOne claims one due run, executes it and records the outcome. It reports whether it ran one.
// Only a run still marked running is updated, so a kill is never overwritten.
func (j *Jobs) runOne(ctx context.Context, exec Executor) (bool, error) {
	r, ok, err := j.claim(ctx)
	if err != nil || !ok {
		return false, err
	}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	j.mu.Lock()
	j.cancels[r.ID] = cancel
	j.mu.Unlock()
	defer func() { j.mu.Lock(); delete(j.cancels, r.ID); j.mu.Unlock() }()
	var status string // a Kill that landed before the cancel was registered
	if err := j.db.QueryRowContext(ctx, `SELECT status FROM job_runs WHERE id=?`, r.ID).Scan(&status); err == nil && status == StatusKilled {
		cancel()
	}

	execErr := exec(rctx, r)
	now := j.now()
	var snooze Snooze
	switch {
	case execErr == nil:
		_, err = j.db.ExecContext(ctx, `UPDATE job_runs SET status='ok', finished_at=? WHERE id=? AND status='running'`, now, r.ID)
	case errors.As(execErr, &snooze), ctx.Err() != nil: // snooze, or the daemon is stopping: not an attempt
		_, err = j.db.ExecContext(context.WithoutCancel(ctx), `UPDATE job_runs SET status='queued', attempt=attempt-1, run_at=? WHERE id=? AND status='running'`,
			now+int64(snooze.After), r.ID)
	case r.Attempt >= j.maxAttempts:
		_, err = j.db.ExecContext(ctx, `UPDATE job_runs SET status='failed', error=?, finished_at=? WHERE id=? AND status='running'`, execErr.Error(), now, r.ID)
	default:
		_, err = j.db.ExecContext(ctx, `UPDATE job_runs SET status='queued', error=?, run_at=? WHERE id=? AND status='running'`,
			execErr.Error(), now+int64(backoff(r.Attempt, j.rnd)), r.ID)
	}
	return true, err
}

// sleep waits d or until ctx ends, and reports whether to keep going.
func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// Run drives the scheduler until ctx ends: one goroutine renews the lease and ticks while this
// daemon leads, another claims and executes runs, polling every poll when the queue is empty.
func (j *Jobs) Run(ctx context.Context, exec Executor, poll time.Duration) {
	var wg sync.WaitGroup
	wg.Go(func() {
		for {
			if err := j.TickIfLeader(ctx); err != nil && ctx.Err() == nil {
				j.logf("scheduler tick: %v", err)
			}
			if !sleep(ctx, renewDelay(j.leaseTTL, j.rnd)) {
				return
			}
		}
	})
	wg.Go(func() {
		for {
			if _, err := j.Requeue(ctx); err != nil && ctx.Err() == nil {
				j.logf("scheduler requeue: %v", err)
			}
			for {
				ran, err := j.runOne(ctx, exec)
				if err != nil && ctx.Err() == nil {
					j.logf("scheduler run: %v", err)
				}
				if err != nil || !ran || ctx.Err() != nil {
					break
				}
			}
			if !sleep(ctx, poll) {
				return
			}
		}
	})
	wg.Wait()
}

// jobStatus maps a job control error to an HTTP status.
func jobStatus(err error) int {
	switch {
	case errors.Is(err, ErrNoJob):
		return http.StatusNotFound
	case errors.Is(err, ErrNotRunning):
		return http.StatusConflict
	}
	return http.StatusInternalServerError
}

// jobAction serves POST /jobs/{id}/{pause|unpause|run|kill}.
func (s *Server) jobAction(w http.ResponseWriter, r *http.Request) {
	if s.jobs == nil {
		http.Error(w, "no jobs configured", http.StatusNotFound)
		return
	}
	id := r.PathValue("id")
	var err error
	switch a := r.PathValue("action"); a {
	case "pause":
		err = s.jobs.Pause(r.Context(), id)
	case "unpause":
		err = s.jobs.Unpause(r.Context(), id)
	case "run":
		err = s.jobs.RunNow(r.Context(), id)
	case "kill":
		err = s.jobs.Kill(r.Context(), id)
	default:
		http.Error(w, "unknown action "+a, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), jobStatus(err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// jobCron serves PUT /jobs/{id}/cron; the body is the new cron expression.
func (s *Server) jobCron(w http.ResponseWriter, r *http.Request) {
	if s.jobs == nil {
		http.Error(w, "no jobs configured", http.StatusNotFound)
		return
	}
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<10))
	if err != nil {
		http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
		return
	}
	spec := strings.TrimSpace(string(b))
	if err := validCron(spec); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.jobs.SetCron(r.Context(), r.PathValue("id"), spec); err != nil {
		http.Error(w, err.Error(), jobStatus(err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// jobRuns serves GET /jobs/{id}/runs: the job's run history as JSON.
func (s *Server) jobRuns(w http.ResponseWriter, r *http.Request) {
	if s.jobs == nil {
		http.Error(w, "no jobs configured", http.StatusNotFound)
		return
	}
	h, err := s.jobs.History(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(h)
}

// jobAdd serves PUT /jobs/{id}: create the job, or replace its cron; the body is the cron expression.
func (s *Server) jobAdd(w http.ResponseWriter, r *http.Request) {
	if s.jobs == nil {
		http.Error(w, "no jobs configured", http.StatusNotFound)
		return
	}
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<10))
	if err != nil {
		http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
		return
	}
	if err := s.jobs.Add(r.Context(), r.PathValue("id"), strings.TrimSpace(string(b))); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
