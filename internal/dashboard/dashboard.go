// Package dashboard is the read-only web view of the factory: board, queue and
// ticket timeline, server-rendered, with one SSE endpoint for live updates.
// It reaches the core only through api.Control and never calls a write method.
package dashboard

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/api"
)

//go:embed templates/*.html
var templateFS embed.FS

// DefaultAddr is the listen address of `factory dashboard`: loopback only.
const DefaultAddr = "127.0.0.1:8787"

// Options configures Handler.
type Options struct {
	// Operator shows usage and budget numbers. False by default.
	Operator bool
}

type server struct {
	ctl  api.Control
	opts Options
	tpl  *template.Template
}

// Handler returns the read-only dashboard. It has no route that accepts a write method.
func Handler(ctl api.Control, opts Options) http.Handler {
	s := &server{
		ctl:  ctl,
		opts: opts,
		tpl:  template.Must(template.ParseFS(templateFS, "templates/*.html")),
	}
	mux := http.NewServeMux()
	for pat, h := range s.routes() {
		mux.HandleFunc(pat, h)
	}
	return mux
}

// routes maps every route pattern the handler registers to its handler. All are GET.
func (s *server) routes() map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"GET /{$}": s.page("board.html"), "GET /queue": s.page("queue.html"),
		"GET /ticket/{id}": s.ticket, "GET /events": s.events,
	}
}

// groupOf puts a phase in one of the three groups the factory-plane home screen used.
func groupOf(p api.Phase) string {
	switch p {
	case api.PhaseNeedsHuman, api.PhaseStalled:
		return "Needs you"
	case api.PhaseReady, api.PhaseClaimed, api.PhaseRunning, api.PhaseRetryQueue:
		return "Running"
	default:
		return "Done"
	}
}

// groupCounts counts the board's slots per group.
func groupCounts(b api.Board) map[string]int {
	m := map[string]int{}
	for _, sl := range b.Slots {
		m[groupOf(sl.Phase)]++
	}
	return m
}

type view struct {
	Groups     map[string]int
	Operator   bool
	Board      api.Board
	Slot       api.Slot
	History    []historyItem
	HasHistory bool // the Control keeps history; false shows a note instead of a list
}

// historyItem is one past event on the ticket page. Key matches the key the page script
// builds from a live event, so the script can skip an event the page already lists.
type historyItem struct {
	Key  string
	Time string
	Kind string
}

func newHistoryItem(e api.Event) historyItem {
	t := e.Time.Format(time.RFC3339Nano)
	return historyItem{Key: t + " " + e.Kind, Time: t, Kind: e.Kind}
}

func (s *server) render(w http.ResponseWriter, name string, v view) {
	var buf bytes.Buffer
	v.Operator = s.opts.Operator
	v.Groups = groupCounts(v.Board)
	if err := s.tpl.ExecuteTemplate(&buf, name, v); err != nil {
		http.Error(w, "render failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(buf.Bytes())
}

func (s *server) page(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := s.ctl.Board(r.Context())
		if err != nil {
			http.Error(w, "board unavailable", http.StatusBadGateway)
			return
		}
		s.render(w, name, view{Board: b})
	}
}

func (s *server) ticket(w http.ResponseWriter, r *http.Request) {
	b, err := s.ctl.Board(r.Context())
	if err != nil {
		http.Error(w, "board unavailable", http.StatusBadGateway)
		return
	}
	id := api.TicketID(r.PathValue("id"))
	for _, sl := range b.Slots {
		if sl.Ticket.ID == id {
			v := view{Board: b, Slot: sl}
			if h, ok := s.ctl.(api.Historian); ok {
				evs, err := h.History(r.Context(), id)
				if err != nil {
					http.Error(w, "history unavailable", http.StatusBadGateway)
					return
				}
				v.HasHistory = true
				for _, e := range evs {
					if !s.opts.Operator && hidden(e.Kind) {
						continue
					}
					v.History = append(v.History, newHistoryItem(e))
				}
			}
			s.render(w, "ticket.html", v)
			return
		}
	}
	http.NotFound(w, r)
}

// hidden reports whether an event kind carries usage, budget or cost.
func hidden(kind string) bool {
	k := strings.ToLower(kind)
	return strings.Contains(k, "usage") || strings.Contains(k, "budget") || strings.Contains(k, "cost")
}

func (s *server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	ch, err := s.ctl.Events(r.Context())
	if err != nil {
		http.Error(w, "events unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = fmt.Fprint(w, ": ok\n\n")
	fl.Flush()
	beat := time.NewTicker(25 * time.Second)
	defer beat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-beat.C:
			_, _ = fmt.Fprint(w, ": keepalive\n\n")
			fl.Flush()
		case e, open := <-ch:
			if !open {
				return
			}
			if !s.opts.Operator {
				if hidden(e.Kind) {
					continue
				}
				e.Data = nil
			}
			line, err := json.Marshal(e)
			if err != nil {
				continue
			}
			_, _ = fmt.Fprintf(w, "data: %s\n\n", line)
			fl.Flush()
		}
	}
}

type ctlKey struct{}

// WithControl returns a context that carries the Control NewCommand serves.
func WithControl(ctx context.Context, ctl api.Control) context.Context {
	return context.WithValue(ctx, ctlKey{}, ctl)
}

// NewCommand returns `factory dashboard`, which serves Handler until its context ends.
// The Control comes from the command context (see WithControl).
func NewCommand() *cobra.Command {
	var addr string
	var operator bool
	cmd := &cobra.Command{
		Use:   "dashboard",
		Short: "Serve the read-only web view",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			ctl, ok := ctx.Value(ctlKey{}).(api.Control)
			if !ok {
				return errors.New("dashboard: no Control in the command context")
			}
			ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", addr)
			if err != nil {
				return err
			}
			srv := &http.Server{Handler: Handler(ctl, Options{Operator: operator}), ReadHeaderTimeout: 10 * time.Second}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "dashboard on http://%s\n", ln.Addr())
			done := make(chan struct{})
			go func() {
				defer close(done)
				<-ctx.Done()
				sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				_ = srv.Shutdown(sctx)
				_ = srv.Close()
			}()
			err = srv.Serve(ln)
			if errors.Is(err, http.ErrServerClosed) {
				<-done
				return nil
			}
			return err
		},
	}
	cmd.Flags().StringVar(&addr, "addr", DefaultAddr, "listen address (loopback by default)")
	cmd.Flags().BoolVar(&operator, "operator", false, "show usage and budget numbers")
	return cmd
}
