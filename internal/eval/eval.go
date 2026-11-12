// Package eval runs a matrix of fixtures through injected dispatch, gate and
// hidden-test interfaces and scores the result. It never calls a model.
package eval

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/eval/grade"
	"github.com/KaaS-team/factory/internal/trace"
)

// SchemaV1 is the version string written into every scorecard.
const SchemaV1 = "factory.scorecard/v1"

// DefaultMargin is how much tokens per merged PR may rise before Compare says worse.
const DefaultMargin = 0.10

// FixtureTicket is one ticket in a fixture.
type FixtureTicket struct {
	api.Ticket
	// Grade, when set, makes the hidden command run under grade.Script and be graded from its log.
	Grade *grade.Spec `json:"grade,omitempty"`
}

// Fixture is a repo seed, its tickets and the hidden acceptance command.
type Fixture struct {
	Name    string          `json:"name"`
	Seed    string          `json:"seed,omitempty"`
	Gate    string          `json:"gate,omitempty"` // command that says main is green after a ticket
	Tickets []FixtureTicket `json:"tickets"`
	Hidden  string          `json:"hidden"`
}

// Matrix is the set of fixtures one eval run covers.
type Matrix struct {
	Fixtures []Fixture `json:"fixtures"`
}

// Outcome is what a dispatcher run reports for one ticket: absolute usage
// updates as they arrived (Symphony §13.5), attempts, wall time and human touches.
type Outcome struct {
	Attempts     int
	Updates      []api.Usage
	Wall         time.Duration
	HumanTouches int
}

// Deps are the injected collaborators; tests pass fakes, never a model.
type Deps interface {
	// Dispatch runs the workflow for one ticket.
	Dispatch(ctx context.Context, t api.Ticket) (Outcome, error)
	// Gate reports whether the base branch stayed green after the ticket.
	Gate(ctx context.Context, t api.Ticket) (bool, error)
	// HiddenTest runs the fixture's hidden acceptance command for the ticket.
	HiddenTest(ctx context.Context, t api.Ticket, command string) (bool, error)
}

// TicketResult is the scorecard row for one ticket.
type TicketResult struct {
	Fixture      string        `json:"fixture"`
	Ticket       api.TicketID  `json:"ticket"`
	HiddenPass   bool          `json:"hidden_pass"`
	BaseGreen    bool          `json:"base_green"`
	Merged       bool          `json:"merged"`
	InputTokens  int64         `json:"input_tokens"`
	OutputTokens int64         `json:"output_tokens"`
	CostUSD      float64       `json:"cost_usd,omitempty"`
	WallTime     time.Duration `json:"wall_time"`
	Attempts     int           `json:"attempts"`
	HumanTouches int           `json:"human_touches"`
}

// Aggregate is the summary the pack upgrade loop compares.
type Aggregate struct {
	PassRate          float64       `json:"pass_rate"`
	MainGreenRate     float64       `json:"main_green_rate"`
	TokensPerMergedPR int64         `json:"tokens_per_merged_pr"`
	MedianWallTime    time.Duration `json:"median_wall_time"`
	HumanTouchesPerPR float64       `json:"human_touches_per_pr"`
	Merged            int           `json:"merged"`
	Total             int           `json:"total"`
}

// Scorecard is the versioned eval result (schema factory.scorecard/v1).
type Scorecard struct {
	Schema string `json:"schema"`
	// Model is kept only so internal/upgrade still compiles. `factory eval` never sets it.
	Model     string         `json:"model,omitempty"`
	Workflow  string         `json:"workflow,omitempty"`
	Agent     string         `json:"agent,omitempty"` // preset name, never a model name
	Packs     string         `json:"packs,omitempty"` // sha256 of the lock file the run used
	Tickets   []TicketResult `json:"tickets"`
	Aggregate Aggregate      `json:"aggregate"`
}

// AbsoluteTotals folds usage updates that carry absolute totals: the largest
// seen per counter wins, so a repeated update counts once (Symphony §13.5).
func AbsoluteTotals(updates []api.Usage) (in, out int64) {
	for _, u := range updates {
		in = max(in, u.InputTokens)
		out = max(out, u.OutputTokens)
	}
	return in, out
}

func maxCost(updates []api.Usage) float64 {
	var c float64
	for _, u := range updates {
		c = max(c, u.CostUSD)
	}
	return c
}

// RunOption configures Run.
type RunOption func(*runOptions)

type runOptions struct{ sink trace.Sink }

// WithSink records one trace per ticket: an agent span, a generation span with token counts and a
// gate span for the base gate and one for the hidden test, each flagged triggered when it failed.
func WithSink(s trace.Sink) RunOption { return func(o *runOptions) { o.sink = s } }

// Run executes every ticket of every fixture and returns the scorecard.
func Run(ctx context.Context, m Matrix, d Deps, opts ...RunOption) (Scorecard, error) {
	var ro runOptions
	for _, f := range opts {
		f(&ro)
	}
	sc := Scorecard{Schema: SchemaV1}
	for _, f := range m.Fixtures {
		for _, ft := range f.Tickets {
			if err := ctx.Err(); err != nil {
				return sc, err
			}
			t := ft.Ticket
			o, err := d.Dispatch(ctx, t)
			if err != nil {
				return sc, fmt.Errorf("dispatch %s/%s: %w", f.Name, t.ID, err)
			}
			green, err := d.Gate(ctx, t)
			if err != nil {
				return sc, fmt.Errorf("gate %s/%s: %w", f.Name, t.ID, err)
			}
			pass, err := d.HiddenTest(ctx, t, f.Hidden)
			if err != nil {
				return sc, fmt.Errorf("hidden test %s/%s: %w", f.Name, t.ID, err)
			}
			in, out := AbsoluteTotals(o.Updates)
			if ro.sink != nil {
				recordTicket(ro.sink, f.Name, t.ID, o, in, out, green, pass)
			}
			sc.Tickets = append(sc.Tickets, TicketResult{
				Fixture: f.Name, Ticket: t.ID, HiddenPass: pass, BaseGreen: green, Merged: pass && green,
				InputTokens: in, OutputTokens: out, CostUSD: maxCost(o.Updates),
				WallTime: o.Wall, Attempts: o.Attempts, HumanTouches: o.HumanTouches,
			})
		}
	}
	sc.Aggregate = aggregate(sc.Tickets)
	return sc, nil
}

func aggregate(rs []TicketResult) Aggregate {
	a := Aggregate{Total: len(rs)}
	var tokens int64
	var touches, green int
	var walls []time.Duration
	for _, r := range rs {
		tokens += r.InputTokens + r.OutputTokens
		walls = append(walls, r.WallTime)
		if r.BaseGreen {
			green++
		}
		if r.Merged {
			a.Merged++
			touches += r.HumanTouches
		}
	}
	if a.Total > 0 {
		a.PassRate = float64(a.Merged) / float64(a.Total)
		a.MainGreenRate = float64(green) / float64(a.Total)
	}
	if a.Merged > 0 {
		a.TokensPerMergedPR = tokens / int64(a.Merged)
		a.HumanTouchesPerPR = float64(touches) / float64(a.Merged)
	}
	a.MedianWallTime = median(walls)
	return a
}

func median(ds []time.Duration) time.Duration {
	if len(ds) == 0 {
		return 0
	}
	s := append([]time.Duration(nil), ds...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	if len(s)%2 == 1 {
		return s[len(s)/2]
	}
	return (s[len(s)/2-1] + s[len(s)/2]) / 2
}

// Verdict is the Compare result: Worse with the reason, or not worse.
type Verdict struct {
	Worse  bool   `json:"worse"`
	Reason string `json:"reason,omitempty"`
}

// Diff renders a table of each metric in old and next with its delta and whether
// next is better, same or worse. `packs upgrade` and `eval diff` both print it.
func Diff(old, next Scorecard) string {
	o, n := old.Aggregate, next.Aggregate
	var b strings.Builder
	b.WriteString("| metric | old | new | delta | verdict |\n|---|---|---|---|---|\n")
	fmt.Fprintf(&b, "| pass rate | %.2f | %.2f | %+.2f | %s |\n", o.PassRate, n.PassRate, n.PassRate-o.PassRate, verdict(n.PassRate-o.PassRate, true))
	fmt.Fprintf(&b, "| main green rate | %.2f | %.2f | %+.2f | %s |\n", o.MainGreenRate, n.MainGreenRate, n.MainGreenRate-o.MainGreenRate, verdict(n.MainGreenRate-o.MainGreenRate, true))
	tok := n.TokensPerMergedPR - o.TokensPerMergedPR
	fmt.Fprintf(&b, "| tokens per merged PR | %d | %d | %+d (%s) | %s |\n", o.TokensPerMergedPR, n.TokensPerMergedPR, tok, pct(o.TokensPerMergedPR, n.TokensPerMergedPR), verdict(float64(tok), false))
	wall := n.MedianWallTime - o.MedianWallTime
	fmt.Fprintf(&b, "| median wall time | %s | %s | %s | %s |\n", o.MedianWallTime, n.MedianWallTime, signed(wall), verdict(float64(wall), false))
	fmt.Fprintf(&b, "| human touches per PR | %.2f | %.2f | %+.2f | %s |\n", o.HumanTouchesPerPR, n.HumanTouchesPerPR, n.HumanTouchesPerPR-o.HumanTouchesPerPR, verdict(n.HumanTouchesPerPR-o.HumanTouchesPerPR, false))
	return b.String()
}

// verdict names a delta: for a higher-is-better metric a rise is better, otherwise a rise is worse.
func verdict(delta float64, higherBetter bool) string {
	switch {
	case delta == 0:
		return "same"
	case (delta > 0) == higherBetter:
		return "better"
	}
	return "worse"
}

func pct(old, next int64) string {
	if old == 0 {
		return "n/a"
	}
	return fmt.Sprintf("%+.1f%%", float64(next-old)/float64(old)*100)
}

func signed(d time.Duration) string {
	if d >= 0 {
		return "+" + d.String()
	}
	return d.String()
}

// Compare says whether next is worse than prev: pass rate dropped, or tokens
// per merged PR rose by more than margin (0 means DefaultMargin).
func Compare(prev, next Scorecard, margin float64) Verdict {
	if margin <= 0 {
		margin = DefaultMargin
	}
	p, n := prev.Aggregate, next.Aggregate
	if n.PassRate < p.PassRate {
		return Verdict{Worse: true, Reason: fmt.Sprintf("pass rate fell from %.2f to %.2f", p.PassRate, n.PassRate)}
	}
	if p.TokensPerMergedPR > 0 && float64(n.TokensPerMergedPR-p.TokensPerMergedPR) > float64(p.TokensPerMergedPR)*margin {
		return Verdict{Worse: true, Reason: fmt.Sprintf("tokens per merged PR rose from %d to %d, more than %.0f%%", p.TokensPerMergedPR, n.TokensPerMergedPR, margin*100)}
	}
	return Verdict{}
}

// Markdown renders the scorecard. The customer view leaves out token counts and cost.
func Markdown(sc Scorecard, customer bool) string {
	var b strings.Builder
	a := sc.Aggregate
	b.WriteString("# Eval scorecard\n\n")
	if !customer && (sc.Workflow != "" || sc.Agent != "") {
		fmt.Fprintf(&b, "Workflow: %s\n\nAgent: %s\n\n", sc.Workflow, sc.Agent)
	}
	fmt.Fprintf(&b, "- Pass rate: %.2f (%d of %d)\n", a.PassRate, a.Merged, a.Total)
	fmt.Fprintf(&b, "- Main green rate: %.2f\n", a.MainGreenRate)
	if !customer {
		fmt.Fprintf(&b, "- Tokens per merged PR: %d\n", a.TokensPerMergedPR)
	}
	fmt.Fprintf(&b, "- Median wall time: %s\n", a.MedianWallTime)
	fmt.Fprintf(&b, "- Human touches per PR: %.2f\n\n", a.HumanTouchesPerPR)
	if customer {
		b.WriteString("| Fixture | Ticket | Passed | Base green | Attempts |\n|---|---|---|---|---|\n")
		for _, r := range sc.Tickets {
			fmt.Fprintf(&b, "| %s | %s | %t | %t | %d |\n", r.Fixture, r.Ticket, r.HiddenPass, r.BaseGreen, r.Attempts)
		}
		return b.String()
	}
	b.WriteString("| Fixture | Ticket | Passed | Base green | Tokens in | Tokens out | Wall | Attempts | Touches |\n|---|---|---|---|---|---|---|---|---|\n")
	for _, r := range sc.Tickets {
		fmt.Fprintf(&b, "| %s | %s | %t | %t | %d | %d | %s | %d | %d |\n", r.Fixture, r.Ticket, r.HiddenPass, r.BaseGreen, r.InputTokens, r.OutputTokens, r.WallTime, r.Attempts, r.HumanTouches)
	}
	return b.String()
}

// LoadMatrix reads every <dir>/*/fixture.yaml. The file is JSON, which is
// valid YAML, so no YAML dependency is needed.
func LoadMatrix(dir string) (Matrix, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*", "fixture.yaml"))
	if err != nil {
		return Matrix{}, err
	}
	sort.Strings(files)
	var m Matrix
	for _, p := range files {
		raw, err := os.ReadFile(p)
		if err != nil {
			return Matrix{}, err
		}
		var f Fixture
		if err := json.Unmarshal(raw, &f); err != nil {
			return Matrix{}, fmt.Errorf("%s: %w", p, err)
		}
		m.Fixtures = append(m.Fixtures, f)
	}
	return m, nil
}

// recordTicket emits the trace of one ticket. Times are not set: the trace is a record of
// verdicts, and replay must not depend on the clock.
func recordTicket(s trace.Sink, fixture string, id api.TicketID, o Outcome, in, out int64, green, pass bool) {
	tid := fixture + "/" + string(id)
	s.OnTraceStart(trace.Trace{ID: tid, Name: tid})
	span := func(sp trace.Span) {
		sp.TraceID = tid
		s.OnSpanStart(sp)
		s.OnSpanEnd(sp)
	}
	span(trace.Span{ID: tid + "#agent", Type: trace.SpanAgent, Name: "dispatch", Output: fmt.Sprintf("%d attempts", o.Attempts)})
	span(trace.Span{ID: tid + "#gen", ParentID: tid + "#agent", Type: trace.SpanGeneration, Name: "usage", InputTokens: in, OutputTokens: out})
	failed := func(ok bool) *bool { f := !ok; return &f }
	span(trace.Span{ID: tid + "#base", Type: trace.SpanGate, Name: "base-green", Triggered: failed(green)})
	span(trace.Span{ID: tid + "#hidden", Type: trace.SpanGate, Name: "hidden", Triggered: failed(pass)})
	s.OnTraceEnd(trace.Trace{ID: tid, Name: tid})
}

// Replay prints what a trace file recorded: each span in order, gate spans with their triggered flag.
func Replay(w io.Writer, lines []trace.Line) error {
	for _, l := range lines {
		if l.Event != trace.EventSpanEnd {
			continue
		}
		sp := l.Span
		var err error
		if sp.Type == trace.SpanGate {
			verdict := "passed"
			if *sp.Triggered {
				verdict = "triggered"
			}
			_, err = fmt.Fprintf(w, "%s gate %s %s\n", sp.TraceID, sp.Name, verdict)
		} else {
			_, err = fmt.Fprintf(w, "%s %s %s\n", sp.TraceID, sp.Type, sp.Name)
		}
		if err != nil {
			return err
		}
	}
	return nil
}
