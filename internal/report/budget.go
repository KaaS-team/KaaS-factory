package report

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/KaaS-team/factory/internal/budget"
	"github.com/spf13/cobra"
)

// BudgetRows turns ticket records into ledger rows. A ticket's spend is stamped at its merge time,
// or its first dispatch when it has not merged.
func BudgetRows(recs []TicketRecord) []budget.Row {
	rows := make([]budget.Row, 0, len(recs))
	for _, r := range recs {
		var usd float64
		for _, a := range r.Attempts {
			usd += a.Usage.CostUSD
		}
		at := r.MergedAt
		if at.IsZero() {
			at = r.FirstDispatch
		}
		rows = append(rows, budget.Row{Team: r.Team, Client: r.Client, At: at, CostUSD: usd})
	}
	return rows
}

func runBudget(cmd *cobra.Command, src Source, path string, now time.Time, asJSON bool, out string) error {
	bs, err := budget.Load(path)
	if err != nil {
		return err
	}
	// The longest period is a month, so 32 days back covers every window.
	recs, err := src.Tickets(cmd.Context(), Window{Since: now.AddDate(0, 0, -32), Until: now.Add(time.Second)})
	if err != nil {
		return err
	}
	st := budget.Check(BudgetRows(recs), bs, now)
	var buf bytes.Buffer
	if asJSON {
		enc := json.NewEncoder(&buf)
		enc.SetIndent("", "  ")
		if err := enc.Encode(struct {
			Budgets []budget.Status `json:"budgets"`
		}{st}); err != nil {
			return err
		}
	} else {
		if len(st) == 0 {
			fmt.Fprintf(&buf, "No budgets set. Add them to %s.\n", path)
		} else {
			buf.WriteString("| scope | period | spent | limit | percent | state |\n| --- | --- | --- | --- | --- | --- |\n")
			for _, s := range st {
				fmt.Fprintf(&buf, "| %s | %s | $%.2f | $%.2f | %.1f%% | %s |\n", s.Scope, s.Period, s.Spent, s.Limit, s.Percent, s.State)
			}
		}
	}
	if out != "" {
		return os.WriteFile(out, buf.Bytes(), 0o600)
	}
	_, err = cmd.OutOrStdout().Write(buf.Bytes())
	return err
}
