// Package serve runs the factory loop as a long-lived service with health and event endpoints.
package serve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/serve/hostguard"
)

// Core is the loop the server hosts: a Control that also owns the poll loop (Symphony 8.1).
type Core interface {
	api.Control
	Run(ctx context.Context) error
}

// Clock tells the time; tests replace it.
type Clock interface{ Now() time.Time }

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

// Options configure a Server.
type Options struct {
	Interval time.Duration // the loop's tick interval; /healthz allows 3 of them since the last tick
	Clock    Clock         // defaults to the wall clock
	Jobs     *Jobs         // optional scheduled jobs; Serve drives them and needs Exec
	JobsPath string        // when Jobs is nil, Serve opens the job database at this path
	Exec     Executor      // runs one job run
}

// Server hosts a Core and serves /healthz, /readyz and /events.
type Server struct {
	core     Core
	interval time.Duration
	clock    Clock
	mu       sync.Mutex
	lastTick time.Time
	ticked   bool
	ready    atomic.Bool
	jobs     *Jobs
	jobsPath string
	exec     Executor
	onListen func(addr string) // test hook: called with the bound address
}

// New returns a Server for core. A zero Interval means 30 seconds, the core's default.
func New(core Core, o Options) *Server {
	if o.Interval <= 0 {
		o.Interval = 30 * time.Second
	}
	if o.Clock == nil {
		o.Clock = realClock{}
	}
	return &Server{core: core, interval: o.Interval, clock: o.Clock, jobs: o.Jobs, jobsPath: o.JobsPath, exec: o.Exec}
}

func (s *Server) markTick() {
	s.mu.Lock()
	s.lastTick, s.ticked = s.clock.Now(), true
	s.mu.Unlock()
}

// Handler returns the HTTP routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.healthz)
	mux.HandleFunc("/readyz", s.readyz)
	mux.HandleFunc("/events", s.events)
	mux.HandleFunc("POST /jobs/{id}/{action}", s.jobAction)
	mux.HandleFunc("PUT /jobs/{id}/cron", s.jobCron)
	mux.HandleFunc("PUT /jobs/{id}", s.jobAdd)
	mux.HandleFunc("GET /jobs/{id}/runs", s.jobRuns)
	return mux
}

// healthz is 200 while the last tick is younger than 3 intervals, 503 otherwise or before any tick.
func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	last, ticked := s.lastTick, s.ticked
	s.mu.Unlock()
	if !ticked {
		http.Error(w, "no tick yet", http.StatusServiceUnavailable)
		return
	}
	if age := s.clock.Now().Sub(last); age >= 3*s.interval {
		http.Error(w, fmt.Sprintf("last tick %s ago", age.Round(time.Second)), http.StatusServiceUnavailable)
		return
	}
	_, _ = fmt.Fprintln(w, "ok")
}

// readyz is 200 once the loop has started.
func (s *Server) readyz(w http.ResponseWriter, _ *http.Request) {
	if !s.ready.Load() {
		http.Error(w, "loop not started", http.StatusServiceUnavailable)
		return
	}
	_, _ = fmt.Fprintln(w, "ready")
}

// events streams every api.Event as one server-sent event until the client leaves.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	ch, err := s.core.Events(r.Context())
	if err != nil {
		http.Error(w, "events unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	fl.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-ch:
			if !ok {
				return
			}
			b, err := json.Marshal(e)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Kind, b); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

// Serve runs the loop and the HTTP server on addr until ctx ends, then stops dispatching and waits
// up to drain for the tick in flight. It returns nil on a clean drain and an error otherwise.
func (s *Server) Serve(ctx context.Context, addr string, drain time.Duration) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	if s.onListen != nil {
		s.onListen(ln.Addr().String())
	}
	if (s.jobs != nil || s.jobsPath != "") && s.exec == nil {
		_ = ln.Close()
		return errors.New("serve: jobs need an Exec")
	}
	if s.jobs == nil && s.jobsPath != "" {
		j, err := OpenJobs(s.jobsPath, s.clock, func(f string, a ...any) { log.Printf(f, a...) })
		if err != nil {
			_ = ln.Close()
			return err
		}
		defer func() { _ = j.Close() }()
		j.SetJitter(DefaultJitterWindow, j.holder)
		s.jobs = j
	}
	ev, err := s.core.Events(ctx)
	if err != nil {
		_ = ln.Close()
		return err
	}
	if s.jobs != nil {
		jctx, stopJobs := context.WithCancel(ctx)
		jobsDone := make(chan struct{})
		go func() { defer close(jobsDone); s.jobs.Run(jctx, s.exec, s.interval) }()
		defer func() {
			stopJobs()
			select {
			case <-jobsDone:
			case <-time.After(drain):
			}
		}()
	}
	go func() {
		for e := range ev {
			if e.Kind == "tick" {
				s.markTick()
			}
		}
	}()
	srv := &http.Server{Handler: hostguard.New(addr, os.Getenv)(s.Handler()), ReadHeaderTimeout: 10 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx }} // ends open /events streams on stop
	httpDone := make(chan error, 1)
	go func() { httpDone <- srv.Serve(ln) }()
	runDone := make(chan error, 1)
	s.ready.Store(true)
	go func() { runDone <- s.core.Run(ctx) }()

	select {
	case err := <-runDone: // the loop ended without ctx ending
		s.stopHTTP(srv, drain)
		if err == nil || errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	case err := <-httpDone:
		return fmt.Errorf("http server: %w", err)
	case <-ctx.Done():
	}
	// Stop dispatching is the ctx cancel itself; now wait for the tick in flight.
	s.ready.Store(false)
	timer := time.NewTimer(drain)
	defer timer.Stop()
	select {
	case err := <-runDone:
		s.stopHTTP(srv, drain)
		if err == nil || errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	case <-timer.C:
		_ = srv.Close()
		return fmt.Errorf("drain: tick still in flight after %s", drain)
	}
}

func (s *Server) stopHTTP(srv *http.Server, d time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
