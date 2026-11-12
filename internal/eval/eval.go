// Package eval runs a matrix of fixtures through injected dispatch, gate and
// hidden-test interfaces and scores the result. It never calls a model.
package eval

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/eval/grade"
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
	// Scorers are commands run cheapest first through HiddenTest; the first to pass decides.
	// Empty means just Hidden.
	Scorers []string `json:"scorers,omitempty"`
	Epochs  int      `json:"epochs,omitempty"`  // runs per ticket, 0 means 1
	Reducer string   `json:"reducer,omitempty"` // mean (default), max, pass_at_k or at_least_k
	K       int      `json:"k,omitempty"`       // for pass_at_k and at_least_k
}

// Matrix is the set of fixtures one eval run covers.
type Matrix struct {
	Fixtures []Fixture `json:"fixtures"`
}

// Outcome is what a dispatcher run reports for one ticket: absolute usage
// updates as they arrived (Symphony §13.5), attempts, wall time and human touches.
type Outcome struct {
	Attempts     int           `json:"attempts"`
	Updates      []api.Usage   `json:"updates,omitempty"`
	Wall         time.Duration `json:"wall"`
	HumanTouches int           `json:"human_touches"`
	Malformed    int           `json:"malformed,omitempty"`   // replies or edits that could not be parsed
	Output       string        `json:"output,omitempty"`      // what the agent produced, kept so --replay can re-score it
	ExitStatus   string        `json:"exit_status,omitempty"` // control arm exit_status
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
	Arm          string        `json:"arm,omitempty"`
	Agent        string        `json:"agent,omitempty"`
	Format       string        `json:"format,omitempty"`
	PassedOn     int           `json:"passed_on,omitempty"` // first try that merged, 0 when none did
	Malformed    int           `json:"malformed_count,omitempty"`
	ExitStatus   string        `json:"exit_status,omitempty"`
	// Epochs holds each run's score; Reduced is the Fixture's reducer applied to them.
	Epochs  []EpochResult `json:"epochs"`
	Reduced float64       `json:"reduced_score"`
}

// EpochResult is one run of a ticket: its score and the scorer stage that decided it.
type EpochResult struct {
	Score     float64 `json:"score"`
	DecidedBy string  `json:"decided_by,omitempty"`
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
	Tries     int            `json:"tries,omitempty"`
	Tickets   []TicketResult `json:"tickets"`
	Cells     []Cell         `json:"cells,omitempty"`
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

// runTicket runs one ticket for the fixture's epochs. Each epoch is scored by a cascade of the
// fixture's scorers; the reducer folds the epoch scores. The ticket passes at PassThreshold,
// and base is green only when it was after every epoch. Usage and wall time add up over epochs.
func runTicket(ctx context.Context, f Fixture, t api.Ticket, d Deps) (TicketResult, []Outcome, error) {
	if f.Epochs < 0 {
		return TicketResult{}, nil, fmt.Errorf("fixture %s: epochs %d is negative", f.Name, f.Epochs)
	}
	epochs := max(f.Epochs, 1)
	red, err := ParseReducer(f.Reducer, f.K, epochs)
	if err != nil {
		return TicketResult{}, nil, fmt.Errorf("fixture %s: %w", f.Name, err)
	}
	cmds := f.Scorers
	if len(cmds) == 0 {
		cmds = []string{f.Hidden}
	}
	r := TicketResult{Fixture: f.Name, Ticket: t.ID, BaseGreen: true}
	var scores []float64
	var outs []Outcome
	for range epochs {
		o, err := d.Dispatch(ctx, t)
		if err != nil {
			return r, outs, fmt.Errorf("dispatch %s/%s: %w", f.Name, t.ID, err)
		}
		green, err := d.Gate(ctx, t)
		if err != nil {
			return r, outs, fmt.Errorf("gate %s/%s: %w", f.Name, t.ID, err)
		}
		stages := make([]Stage, len(cmds))
		for i, c := range cmds {
			stages[i] = Stage{Name: c, Score: func(ctx context.Context) (float64, bool, error) {
				ok, err := d.HiddenTest(ctx, t, c)
				if err != nil {
					return 0, false, fmt.Errorf("hidden test %s/%s: %w", f.Name, t.ID, err)
				}
				if ok {
					return 1, true, nil
				}
				return 0, true, nil
			}}
		}
		dec, err := Cascade(ctx, 1, stages)
		if err != nil {
			return r, outs, err
		}
		outs = append(outs, o)
		in, out := AbsoluteTotals(o.Updates)
		r.InputTokens += in
		r.OutputTokens += out
		r.CostUSD += maxCost(o.Updates)
		r.WallTime += o.Wall
		r.Attempts += o.Attempts
		r.HumanTouches += o.HumanTouches
		r.BaseGreen = r.BaseGreen && green
		r.Epochs = append(r.Epochs, EpochResult{Score: dec.Value, DecidedBy: dec.DecidedBy})
		scores = append(scores, dec.Value)
	}
	if r.Reduced = red.Reduce(scores); math.IsNaN(r.Reduced) {
		r.Reduced = 0
	}
	r.HiddenPass = r.Reduced >= PassThreshold
	r.Merged = r.HiddenPass && r.BaseGreen
	return r, outs, nil
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
	fmt.Fprintf(&b, "- Pass rate: %.2f (%d of %d)", a.PassRate, a.Merged, a.Total)
	if lo, hi, err := Wilson(float64(a.Merged), a.Total, 0.95); err == nil && a.Total > 0 {
		fmt.Fprintf(&b, ", 95%% Wilson interval %.2f to %.2f", lo, hi)
	}
	b.WriteString("\n")
	fmt.Fprintf(&b, "- Main green rate: %.2f\n", a.MainGreenRate)
	if !customer {
		fmt.Fprintf(&b, "- Tokens per merged PR: %d\n", a.TokensPerMergedPR)
	}
	fmt.Fprintf(&b, "- Median wall time: %s\n", a.MedianWallTime)
	fmt.Fprintf(&b, "- Human touches per PR: %.2f\n\n", a.HumanTouchesPerPR)
	b.WriteString(cellTable(sc.Cells, customer))
	for _, r := range sc.Tickets {
		if len(r.Epochs) > 1 {
			fmt.Fprintf(&b, "- %s/%s: reduced score %.2f over %d epochs\n", r.Fixture, r.Ticket, r.Reduced, len(r.Epochs))
		}
	}
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

// cellTable renders one row per cell, so control and preset sit side by side per fixture.
func cellTable(cs []Cell, customer bool) string {
	if len(cs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("| Cell | Tickets | Pass rate by try | Malformed |")
	if !customer {
		b.WriteString(" Cost |")
	}
	b.WriteString("\n|---|---|---|---|")
	if !customer {
		b.WriteString("---|")
	}
	b.WriteString("\n")
	for _, c := range cs {
		var rs []string
		for _, r := range c.PassRates {
			rs = append(rs, fmt.Sprintf("%.2f", r))
		}
		fmt.Fprintf(&b, "| %s | %d | %s | %d |", c.Key(), c.Tickets, strings.Join(rs, " / "), c.Malformed)
		if !customer {
			fmt.Fprintf(&b, " %.4f |", c.CostUSD)
		}
		b.WriteString("\n")
	}
	b.WriteString("\n")
	return b.String()
}
