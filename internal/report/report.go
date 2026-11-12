package report

import (
	"context"
	"errors"
	"fmt"
	"sort"
)

// GroupBy names a grouping of the report's rows.
type GroupBy string

// The groupings `factory report --by` accepts.
const (
	ByTeam     GroupBy = "team"
	ByWorkflow GroupBy = "workflow"
	ByPack     GroupBy = "pack"
)

// Row is the sums for one group, from which every reported figure is derived.
type Row struct {
	Key            string  `json:"key"`
	MergedPRs      int     `json:"merged_prs"`
	MergedTokens   int64   `json:"merged_tokens"`   // all tokens on merged tickets, failed attempts included
	UnmergedTokens int64   `json:"unmerged_tokens"` // tokens on tickets that did not merge in the window
	ReworkAttempts int     `json:"rework_attempts"` // attempts above one, merged tickets only
	HumanTouches   int     `json:"human_touches"`   // merged tickets only
	CostUSD        float64 `json:"cost_usd"`        // all spend, merged or not; 0 when unknown
	CycleSamples   int     `json:"cycle_samples"`   // merged tickets with a usable cycle time
	CycleSeconds   int64   `json:"cycle_seconds"`   // sum of those cycle times
}

func per(n float64, prs int) float64 {
	if prs == 0 {
		return 0
	}
	return n / float64(prs)
}

// TokensPerMergedPR is MergedTokens over MergedPRs, 0 when nothing merged.
func (r Row) TokensPerMergedPR() float64 { return per(float64(r.MergedTokens), r.MergedPRs) }

// ReworkRate is rework attempts per merged PR.
func (r Row) ReworkRate() float64 { return per(float64(r.ReworkAttempts), r.MergedPRs) }

// TouchesPerPR is human touches per merged PR.
func (r Row) TouchesPerPR() float64 { return per(float64(r.HumanTouches), r.MergedPRs) }

// MeanCycleSeconds is the mean cycle time over merged tickets that have one.
func (r Row) MeanCycleSeconds() float64 { return per(float64(r.CycleSeconds), r.CycleSamples) }

// Report is the unit-economics result for one window.
type Report struct {
	Window    Window `json:"-"`
	Total     Row    `json:"total"`
	Teams     []Row  `json:"by_team"`
	Workflows []Row  `json:"by_workflow"`
	Packs     []Row  `json:"by_pack"`
}

// Rows returns the rows for a grouping, or nil for an unknown one.
func (r Report) Rows(by GroupBy) []Row {
	switch by {
	case ByTeam:
		return r.Teams
	case ByWorkflow:
		return r.Workflows
	case ByPack:
		return r.Packs
	}
	return nil
}

func (r *Row) add(rec TicketRecord, w Window) {
	tok := TicketTokens(rec)
	for _, a := range rec.Attempts {
		r.CostUSD += a.Usage.CostUSD
	}
	if !Merged(rec, w) {
		r.UnmergedTokens += tok
		return
	}
	r.MergedPRs++
	r.MergedTokens += tok
	r.ReworkAttempts += Rework(rec)
	r.HumanTouches += HumanTouches(rec)
	if d, ok := CycleTime(rec); ok {
		r.CycleSamples++
		r.CycleSeconds += int64(d.Seconds())
	}
}

func group(recs []TicketRecord, w Window, key func(TicketRecord) string) []Row {
	idx := map[string]*Row{}
	for _, rec := range recs {
		k := key(rec)
		if k == "" {
			k = "(none)"
		}
		if idx[k] == nil {
			idx[k] = &Row{Key: k}
		}
		idx[k].add(rec, w)
	}
	rows := make([]Row, 0, len(idx))
	for _, r := range idx {
		rows = append(rows, *r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Key < rows[j].Key })
	return rows
}

// Build reads the tickets in w from src and computes the report under the definitions in
// definitions.go.
func Build(ctx context.Context, src Source, w Window) (Report, error) {
	if !w.Since.Before(w.Until) {
		return Report{}, errors.New("report: empty window")
	}
	recs, err := src.Tickets(ctx, w)
	if err != nil {
		return Report{}, fmt.Errorf("report: read tickets: %w", err)
	}
	total := Row{Key: "all"}
	for _, rec := range recs {
		total.add(rec, w)
	}
	return Report{
		Window:    w,
		Total:     total,
		Teams:     group(recs, w, func(r TicketRecord) string { return r.Team }),
		Workflows: group(recs, w, func(r TicketRecord) string { return r.Workflow }),
		Packs:     group(recs, w, func(r TicketRecord) string { return r.Pack }),
	}, nil
}
