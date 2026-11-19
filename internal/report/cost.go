package report

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/meter"
)

// CostRow is the cost per surviving merged PR for one repo, or "all".
type CostRow struct {
	Repo string `json:"repo"`
	meter.CostSummary
}

// CostReport is `factory report --cost`: one row per repo and the total.
type CostReport struct {
	ChurnDays int       `json:"churn_days"`
	Total     CostRow   `json:"total"`
	Repos     []CostRow `json:"repos"`
}

// BuildCost groups recs by repo. Spend is every attempt's cost on every ticket, merged or not,
// since failed, verify and rework runs are part of what a surviving PR cost. A PR counts as merged
// when it merged inside w.
func BuildCost(recs []TicketRecord, w Window, churn time.Duration) CostReport {
	type acc struct {
		spend []meter.Spend
		prs   []meter.PR
	}
	byRepo := map[string]*acc{}
	all := &acc{}
	for _, rec := range recs {
		key := rec.Repo
		if key == "" {
			key = "(unknown)"
		}
		if byRepo[key] == nil {
			byRepo[key] = &acc{}
		}
		var usd float64
		for _, a := range rec.Attempts {
			usd += a.Usage.CostUSD
		}
		sp := meter.Spend{Holder: string(rec.ID), CostUSD: usd}
		var prs []meter.PR
		if Merged(rec, w) {
			prs = []meter.PR{{Number: rec.PR, MergedAt: rec.MergedAt, RevertedAt: rec.RevertedAt}}
		}
		for _, a := range []*acc{byRepo[key], all} {
			a.spend = append(a.spend, sp)
			a.prs = append(a.prs, prs...)
		}
	}
	out := CostReport{ChurnDays: int(churn / (24 * time.Hour)), Repos: []CostRow{}}
	out.Total = CostRow{Repo: "all", CostSummary: meter.CostPerSurvivingPR(all.spend, all.prs, churn)}
	keys := make([]string, 0, len(byRepo))
	for k := range byRepo {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out.Repos = append(out.Repos, CostRow{Repo: k, CostSummary: meter.CostPerSurvivingPR(byRepo[k].spend, byRepo[k].prs, churn)})
	}
	return out
}

// WriteCostJSON writes r as indented JSON.
func WriteCostJSON(w io.Writer, r CostReport) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(r)
}

// WriteCostMarkdown writes r as a markdown table.
func WriteCostMarkdown(w io.Writer, r CostReport) error {
	var b strings.Builder
	fmt.Fprintf(&b, "# Cost per surviving merged PR\n\nA revert within %d days of merge means the PR did not survive. Operator data, not for PR bodies.\n\n", r.ChurnDays)
	b.WriteString("| Repo | Merged | Surviving | Revert rate | Spend (USD) | Cost per surviving PR (USD) |\n|---|---|---|---|---|---|\n")
	for _, c := range append([]CostRow{r.Total}, r.Repos...) {
		fmt.Fprintf(&b, "| %s | %d | %d | %s | %s | %s |\n", c.Repo, c.Merged, c.Surviving, num(c.RevertRate), num(c.SpendUSD), num(c.CostPerPRUSD))
	}
	_, err := io.WriteString(w, b.String())
	return err
}
