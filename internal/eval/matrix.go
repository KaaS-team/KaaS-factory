package eval

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/trace"
)

// Arm is one run of the matrix: the axes it covers, how many tries per ticket, and where it keeps state.
// The model axis is the agent preset name; a model name never reaches a scorecard.
type Arm struct {
	Arm, Agent, Format string // arm is "preset" or "control"
	Tries              int    // tries per ticket, 0 means 1
	Store              *RunStore
	Replay             bool       // re-score stored outcomes, never dispatch
	Redo               bool       // ignore finished tickets in the store
	Sink               trace.Sink // when set, one trace per scored run
}

// Cell is one (arm, agent, format, fixture) scorecard cell. pass_rate_k is the share of its
// tickets that merged within k tries, flattened into the JSON as pass_rate_1..pass_rate_N.
type Cell struct {
	Arm       string
	Agent     string
	Format    string
	Fixture   string
	Tickets   int
	PassRates []float64
	CostUSD   float64
	Malformed int
}

// Key names the cell for diffing.
func (c Cell) Key() string {
	return strings.Join([]string{c.Arm, c.Agent, c.Format, c.Fixture}, "/")
}

// MarshalJSON writes the pass rates as pass_rate_1..pass_rate_N next to the other fields.
func (c Cell) MarshalJSON() ([]byte, error) {
	m := map[string]any{"arm": c.Arm, "agent": c.Agent, "format": c.Format, "fixture": c.Fixture,
		"tickets": c.Tickets, "cost_usd": c.CostUSD, "malformed_count": c.Malformed}
	for i, r := range c.PassRates {
		m["pass_rate_"+strconv.Itoa(i+1)] = r
	}
	return json.Marshal(m)
}

// UnmarshalJSON reads what MarshalJSON wrote.
func (c *Cell) UnmarshalJSON(b []byte) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	*c = Cell{}
	for k, v := range m {
		var err error
		switch k {
		case "arm":
			err = json.Unmarshal(v, &c.Arm)
		case "agent":
			err = json.Unmarshal(v, &c.Agent)
		case "format":
			err = json.Unmarshal(v, &c.Format)
		case "fixture":
			err = json.Unmarshal(v, &c.Fixture)
		case "tickets":
			err = json.Unmarshal(v, &c.Tickets)
		case "cost_usd":
			err = json.Unmarshal(v, &c.CostUSD)
		case "malformed_count":
			err = json.Unmarshal(v, &c.Malformed)
		default:
			if n, ok := strings.CutPrefix(k, "pass_rate_"); ok {
				i, perr := strconv.Atoi(n)
				if perr != nil || i < 1 {
					return fmt.Errorf("cell: bad key %q", k)
				}
				for len(c.PassRates) < i {
					c.PassRates = append(c.PassRates, 0)
				}
				err = json.Unmarshal(v, &c.PassRates[i-1])
			}
		}
		if err != nil {
			return fmt.Errorf("cell %s: %w", k, err)
		}
	}
	return nil
}

// RunArm runs every ticket of every fixture up to a.Tries times, stopping a ticket at its first
// merge. With a store it skips tickets finished by an earlier run and saves each result atomically.
func RunArm(ctx context.Context, m Matrix, d Deps, a Arm) (Scorecard, error) {
	tries := max(a.Tries, 1)
	sc := Scorecard{Schema: SchemaV1, Tries: tries}
	if a.Replay {
		if a.Store == nil {
			return sc, fmt.Errorf("replay needs a run directory")
		}
		d = &replayDeps{Deps: d, st: a.Store, calls: map[string]int{}}
	}
	for _, f := range m.Fixtures {
		for _, ft := range f.Tickets {
			if err := ctx.Err(); err != nil {
				return sc, err
			}
			t := ft.Ticket
			key := strings.Join([]string{a.Arm, a.Agent, a.Format, f.Name, string(t.ID)}, "/")
			if done, ok := a.Store.finished(key); ok && !a.Replay && !a.Redo {
				sc.Tickets = append(sc.Tickets, done.Result)
				continue
			}
			if !a.Replay {
				if err := a.Store.begin(key); err != nil {
					return sc, err
				}
			}
			r := TicketResult{Fixture: f.Name, Ticket: t.ID, Arm: a.Arm, Agent: a.Agent, Format: a.Format}
			var outs []Outcome
			var cost float64
			for try := 1; try <= tries; try++ {
				tctx := context.WithValue(ctx, runKey{}, runInfo{key: key, save: a.Store.trajectory(key, a.Replay)})
				tr, os, err := runTicket(tctx, f, t, d, a.Sink)
				if err != nil {
					return sc, err
				}
				outs = append(outs, os...)
				r.InputTokens += tr.InputTokens
				r.OutputTokens += tr.OutputTokens
				cost += tr.CostUSD
				r.WallTime += tr.WallTime
				r.Attempts += tr.Attempts
				r.HumanTouches += tr.HumanTouches
				for _, o := range os {
					r.Malformed += o.Malformed
					r.ExitStatus = o.ExitStatus
				}
				r.HiddenPass, r.BaseGreen = tr.HiddenPass, tr.BaseGreen
				r.Epochs, r.Reduced = tr.Epochs, tr.Reduced
				pass, green := tr.HiddenPass, tr.BaseGreen
				if pass && green {
					r.PassedOn = try
					break
				}
			}
			r.CostUSD = cost
			r.Merged = r.PassedOn > 0
			sc.Tickets = append(sc.Tickets, r)
			if !a.Replay {
				if err := a.Store.finish(key, storedTicket{Result: r, Outcomes: outs}); err != nil {
					return sc, err
				}
			}
		}
	}
	sc.Cells = cells(sc.Tickets, tries)
	sc.Aggregate = aggregate(sc.Tickets)
	return sc, nil
}

func cells(rs []TicketResult, tries int) []Cell {
	idx := map[string]int{}
	var out []Cell
	for _, r := range rs {
		c := Cell{Arm: r.Arm, Agent: r.Agent, Format: r.Format, Fixture: r.Fixture}
		i, ok := idx[c.Key()]
		if !ok {
			i = len(out)
			idx[c.Key()] = i
			c.PassRates = make([]float64, tries)
			out = append(out, c)
		}
		out[i].Tickets++
		out[i].CostUSD += r.CostUSD
		out[i].Malformed += r.Malformed
		for k := max(r.PassedOn, 1); r.PassedOn > 0 && k <= tries; k++ {
			out[i].PassRates[k-1]++
		}
	}
	for i := range out {
		for k := range out[i].PassRates {
			out[i].PassRates[k] /= float64(out[i].Tickets)
		}
	}
	return out
}

type (
	runKey  struct{}
	runInfo struct {
		key  string
		save func([]Message)
	}
)

// replayDeps serves stored outcomes in place of a dispatch and re-scores them with the real gate and hidden test.
type replayDeps struct {
	Deps
	st    *RunStore
	calls map[string]int
}

func (r *replayDeps) Dispatch(ctx context.Context, _ api.Ticket) (Outcome, error) {
	info, _ := ctx.Value(runKey{}).(runInfo)
	done, ok := r.st.finished(info.key)
	n := r.calls[info.key]
	if !ok || n >= len(done.Outcomes) {
		return Outcome{}, fmt.Errorf("replay: no stored output for %s try %d", info.key, n+1)
	}
	r.calls[info.key]++
	return done.Outcomes[n], nil
}

// RunStore keeps a run on disk: results.json (rewritten atomically after each ticket) and one
// trajectory file per ticket, so a killed run restarts at the first unfinished ticket.
type RunStore struct {
	dir  string
	done map[string]storedTicket
}

type storedTicket struct {
	Result   TicketResult `json:"result"`
	Outcomes []Outcome    `json:"outcomes"`
}

const runSchema = "factory.run/v1"

// OpenRunStore loads dir/results.json, or starts empty when it is missing.
func OpenRunStore(dir string) (*RunStore, error) {
	s := &RunStore{dir: dir, done: map[string]storedTicket{}}
	b, err := os.ReadFile(filepath.Join(dir, "results.json"))
	if os.IsNotExist(err) {
		return s, os.MkdirAll(dir, 0o755)
	}
	if err != nil {
		return nil, err
	}
	var f struct {
		Schema string                  `json:"schema"`
		Done   map[string]storedTicket `json:"done"`
	}
	if err := json.Unmarshal(b, &f); err != nil || f.Schema != runSchema {
		return nil, fmt.Errorf("%s/results.json: not a %s file", dir, runSchema)
	}
	s.done = f.Done
	return s, nil
}

func (s *RunStore) finished(key string) (storedTicket, bool) {
	if s == nil {
		return storedTicket{}, false
	}
	v, ok := s.done[key]
	return v, ok
}

func (s *RunStore) ticketDir(key string) string { return filepath.Join(s.dir, url.PathEscape(key)) }

// begin removes what an earlier unfinished attempt at key left behind.
func (s *RunStore) begin(key string) error {
	if s == nil {
		return nil
	}
	delete(s.done, key)
	return os.RemoveAll(s.ticketDir(key))
}

// trajectory returns the saver for key's history, or nil without a store or during replay.
func (s *RunStore) trajectory(key string, replay bool) func([]Message) {
	if s == nil || replay {
		return nil
	}
	return func(msgs []Message) {
		b, err := json.MarshalIndent(msgs, "", "  ")
		if err == nil && os.MkdirAll(s.ticketDir(key), 0o755) == nil {
			_ = os.WriteFile(filepath.Join(s.ticketDir(key), "trajectory.json"), b, 0o644)
		}
	}
}

func (s *RunStore) finish(key string, t storedTicket) error {
	if s == nil {
		return nil
	}
	s.done[key] = t
	b, err := json.MarshalIndent(map[string]any{"schema": runSchema, "done": s.done}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, "results-*.tmp")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(append(b, '\n'))
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.Remove(tmp.Name())
		return werr
	}
	return os.Rename(tmp.Name(), filepath.Join(s.dir, "results.json"))
}
