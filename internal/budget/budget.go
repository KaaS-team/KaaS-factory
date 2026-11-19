// Package budget holds pooled spend caps per team and per client. A budget has a scope, a limit,
// a period and a soft alert percent. The shape follows LiteLLM budgets.
package budget

import (
	"fmt"
	"math"
	"time"
)

// Period is how long a budget runs before it resets. Windows are UTC.
type Period string

// The periods a budget may use.
const (
	Day   Period = "day"
	Week  Period = "week" // starts Monday
	Month Period = "month"
)

// State is where a scope stands against its limit.
type State string

// The three states.
const (
	OK    State = "ok"
	Alert State = "alert"
	Over  State = "over"
)

// DefaultAlertPercent is the soft alert threshold when a budget sets none.
const DefaultAlertPercent = 80

// Budget caps the spend of one scope. Scope is "team:<label>" or "client:<label>".
type Budget struct {
	Scope        string  `yaml:"scope" json:"scope"`
	LimitUSD     float64 `yaml:"limit_usd" json:"limit_usd"`
	Period       Period  `yaml:"period" json:"period"`
	AlertPercent float64 `yaml:"alert_percent" json:"alert_percent"`
}

// Row is one ledger row: spend by a team and client at a time.
type Row struct {
	Team    string
	Client  string
	At      time.Time
	CostUSD float64
}

// Status is the result of Check for one scope.
type Status struct {
	Scope   string  `json:"scope"`
	Period  Period  `json:"period"`
	Spent   float64 `json:"spent_usd"`
	Limit   float64 `json:"limit_usd"`
	Percent float64 `json:"percent"`
	State   State   `json:"state"`
	Since   string  `json:"since"`
	Resets  string  `json:"resets"`
}

// Start returns the start of the period window that holds now.
func Start(p Period, now time.Time) time.Time {
	n := now.UTC()
	d := time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
	switch p {
	case Week:
		return d.AddDate(0, 0, -((int(d.Weekday()) + 6) % 7))
	case Month:
		return time.Date(n.Year(), n.Month(), 1, 0, 0, 0, 0, time.UTC)
	}
	return d
}

func end(p Period, start time.Time) time.Time {
	switch p {
	case Week:
		return start.AddDate(0, 0, 7)
	case Month:
		return start.AddDate(0, 1, 0)
	}
	return start.AddDate(0, 0, 1)
}

func matches(scope string, r Row) bool {
	return scope == "team:"+r.Team || scope == "client:"+r.Client
}

// Check is pure. For each budget it sums the rows inside the current period window and returns
// spent, limit, percent and state, in budget order. A row counts when it is in [start, now].
func Check(rows []Row, budgets []Budget, now time.Time) []Status {
	out := make([]Status, 0, len(budgets))
	for _, b := range budgets {
		start := Start(b.Period, now)
		var spent float64
		for _, r := range rows {
			if matches(b.Scope, r) && !r.At.Before(start) && !r.At.After(now) {
				spent += r.CostUSD
			}
		}
		alert := b.AlertPercent
		if alert <= 0 {
			alert = DefaultAlertPercent
		}
		pct := 0.0
		if b.LimitUSD > 0 {
			pct = math.Round(spent/b.LimitUSD*1000) / 10
		}
		st := OK
		switch {
		case spent >= b.LimitUSD:
			st = Over
		case pct >= alert:
			st = Alert
		}
		out = append(out, Status{Scope: b.Scope, Period: b.Period, Spent: math.Round(spent*1e6) / 1e6, Limit: b.LimitUSD,
			Percent: pct, State: st, Since: start.Format(time.RFC3339), Resets: end(b.Period, start).Format(time.RFC3339)})
	}
	return out
}

// Validate reports the first problem in budgets.
func Validate(budgets []Budget) error {
	seen := map[string]bool{}
	for i, b := range budgets {
		switch {
		case len(b.Scope) < 6 || (b.Scope[:5] != "team:" && (len(b.Scope) < 8 || b.Scope[:7] != "client:")):
			return fmt.Errorf("budget %d: scope %q must be team:<label> or client:<label>", i+1, b.Scope)
		case b.LimitUSD <= 0:
			return fmt.Errorf("budget %q: limit_usd must be above 0", b.Scope)
		case b.Period != Day && b.Period != Week && b.Period != Month:
			return fmt.Errorf("budget %q: period must be day, week or month, not %q", b.Scope, b.Period)
		case b.AlertPercent < 0 || b.AlertPercent > 100:
			return fmt.Errorf("budget %q: alert_percent must be between 0 and 100", b.Scope)
		case seen[b.Scope]:
			return fmt.Errorf("budget %q appears twice", b.Scope)
		}
		seen[b.Scope] = true
	}
	return nil
}
