package report

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// View is a Row with its derived figures, rounded once. Markdown and JSON both print a View, so
// they cannot disagree.
type View struct {
	Key               string  `json:"key"`
	MergedPRs         int     `json:"merged_prs"`
	TokensPerMergedPR float64 `json:"tokens_per_merged_pr"`
	ReworkRate        float64 `json:"rework_rate"`
	HumanTouchesPerPR float64 `json:"human_touches_per_pr"`
	MeanCycleSeconds  float64 `json:"mean_cycle_seconds"`
	MergedTokens      int64   `json:"merged_tokens"`
	UnmergedTokens    int64   `json:"unmerged_tokens"`
	CostUSD           float64 `json:"cost_usd"`
}

func round(f float64, places int) float64 {
	p := math.Pow10(places)
	return math.Round(f*p) / p
}

// ViewOf derives r's reported figures: tokens and cycle time to whole numbers, rates and cost to
// two places.
func ViewOf(r Row) View {
	return View{
		Key:               r.Key,
		MergedPRs:         r.MergedPRs,
		TokensPerMergedPR: round(r.TokensPerMergedPR(), 0),
		ReworkRate:        round(r.ReworkRate(), 2),
		HumanTouchesPerPR: round(r.TouchesPerPR(), 2),
		MeanCycleSeconds:  round(r.MeanCycleSeconds(), 0),
		MergedTokens:      r.MergedTokens,
		UnmergedTokens:    r.UnmergedTokens,
		CostUSD:           round(r.CostUSD, 2),
	}
}

func views(r Report, by GroupBy) ([]View, error) {
	if by != ByTeam && by != ByWorkflow && by != ByPack {
		return nil, fmt.Errorf("report: unknown grouping %q", by)
	}
	var out []View
	for _, row := range r.Rows(by) {
		out = append(out, ViewOf(row))
	}
	return out, nil
}

func num(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// WriteJSON writes the total and the rows for by as indented JSON.
func WriteJSON(w io.Writer, r Report, by GroupBy) error {
	rows, err := views(r, by)
	if err != nil {
		return err
	}
	doc := struct {
		Since string `json:"since,omitempty"`
		Until string `json:"until,omitempty"`
		By    string `json:"by"`
		Total View   `json:"total"`
		Rows  []View `json:"rows"`
	}{By: string(by), Total: ViewOf(r.Total), Rows: rows}
	if !r.Window.Since.IsZero() {
		doc.Since = r.Window.Since.UTC().Format("2006-01-02T15:04:05Z")
		doc.Until = r.Window.Until.UTC().Format("2006-01-02T15:04:05Z")
	}
	if doc.Rows == nil {
		doc.Rows = []View{}
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(doc)
}

// WriteMarkdown writes the total and the rows for by as a markdown table. Cycle time is in seconds.
func WriteMarkdown(w io.Writer, r Report, by GroupBy) error {
	rows, err := views(r, by)
	if err != nil {
		return err
	}
	var b strings.Builder
	b.WriteString("# Factory unit economics\n\n")
	if !r.Window.Since.IsZero() {
		fmt.Fprintf(&b, "Window: %s to %s (UTC). Operator data, not for PR bodies.\n\n",
			r.Window.Since.UTC().Format("2006-01-02 15:04"), r.Window.Until.UTC().Format("2006-01-02 15:04"))
	}
	fmt.Fprintf(&b, "| %s | Merged PRs | Tokens per merged PR | Rework per PR | Human touches per PR | Mean cycle (s) | Merged tokens | Unmerged tokens | Cost (USD) |\n", by)
	b.WriteString("|---|---|---|---|---|---|---|---|---|\n")
	for _, v := range append([]View{ViewOf(r.Total)}, rows...) {
		fmt.Fprintf(&b, "| %s | %d | %s | %s | %s | %s | %d | %d | %s |\n", v.Key, v.MergedPRs,
			num(v.TokensPerMergedPR), num(v.ReworkRate), num(v.HumanTouchesPerPR), num(v.MeanCycleSeconds),
			v.MergedTokens, v.UnmergedTokens, num(v.CostUSD))
	}
	_, err = io.WriteString(w, b.String())
	return err
}
