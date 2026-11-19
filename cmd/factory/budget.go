package main

import (
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/KaaS-team/factory/internal/budget"
)

// spendPath is the ledger rows the budget guard reads: a JSON list of {team, client, at, cost_usd}.
const spendPath = ".factory/state/spend.json"

// configureBudget points budget.Allow at the repo's budgets and spend rows. Both are read on every
// call, so an edit to either takes effect without a restart. Missing files mean no budget.
func configureBudget() {
	budget.Configure(&budget.Guard{
		Budgets: func() ([]budget.Budget, error) { return budget.Load(budget.DefaultPath) },
		Rows:    func() ([]budget.Row, error) { return loadSpend(spendPath) },
	})
}

func loadSpend(path string) ([]budget.Row, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var in []struct {
		Team    string    `json:"team"`
		Client  string    `json:"client"`
		At      time.Time `json:"at"`
		CostUSD float64   `json:"cost_usd"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		return nil, err
	}
	rows := make([]budget.Row, len(in))
	for i, r := range in {
		rows[i] = budget.Row{Team: r.Team, Client: r.Client, At: r.At, CostUSD: r.CostUSD}
	}
	return rows, nil
}
