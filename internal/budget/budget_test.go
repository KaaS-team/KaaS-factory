package budget

import (
	"errors"
	"testing"
	"time"
)

func ts(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestCheck(t *testing.T) {
	now := ts("2026-11-19T12:00:00Z") // a Thursday
	b := func(p Period, alert float64) []Budget {
		return []Budget{{Scope: "team:alpha", LimitUSD: 100, Period: p, AlertPercent: alert}}
	}
	row := func(at string, usd float64) Row { return Row{Team: "alpha", At: ts(at), CostUSD: usd} }
	cases := []struct {
		name    string
		rows    []Row
		budgets []Budget
		spent   float64
		pct     float64
		state   State
	}{
		{"under", []Row{row("2026-11-19T01:00:00Z", 30)}, b(Day, 80), 30, 30, OK},
		{"at alert percent", []Row{row("2026-11-19T01:00:00Z", 80)}, b(Day, 80), 80, 80, Alert},
		{"default alert is 80", []Row{row("2026-11-19T01:00:00Z", 85)}, b(Day, 0), 85, 85, Alert},
		{"at limit is over", []Row{row("2026-11-19T01:00:00Z", 60), row("2026-11-19T02:00:00Z", 40)}, b(Day, 80), 100, 100, Over},
		{"over", []Row{row("2026-11-19T01:00:00Z", 130)}, b(Day, 80), 130, 130, Over},
		{"day rollover drops yesterday", []Row{row("2026-11-18T23:59:59Z", 500), row("2026-11-19T00:00:00Z", 10)}, b(Day, 80), 10, 10, OK},
		{"week rolls over on Monday", []Row{row("2026-11-15T23:00:00Z", 500), row("2026-11-16T00:00:00Z", 50)}, b(Week, 80), 50, 50, OK},
		{"month rollover drops last month", []Row{row("2026-10-31T23:00:00Z", 500), row("2026-11-01T00:00:00Z", 20)}, b(Month, 80), 20, 20, OK},
		{"other team ignored", []Row{{Team: "beta", At: ts("2026-11-19T01:00:00Z"), CostUSD: 999}}, b(Day, 80), 0, 0, OK},
		{"future row ignored", []Row{row("2026-11-19T13:00:00Z", 999)}, b(Day, 80), 0, 0, OK},
		{"client scope", []Row{{Team: "x", Client: "acme", At: ts("2026-11-19T01:00:00Z"), CostUSD: 90}},
			[]Budget{{Scope: "client:acme", LimitUSD: 100, Period: Day, AlertPercent: 80}}, 90, 90, Alert},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Check(c.rows, c.budgets, now)
			if len(got) != 1 {
				t.Fatalf("got %d statuses", len(got))
			}
			s := got[0]
			if s.Spent != c.spent || s.Percent != c.pct || s.State != c.state || s.Limit != 100 {
				t.Fatalf("got %+v", s)
			}
		})
	}
}

func TestStart(t *testing.T) {
	now := ts("2026-11-19T12:00:00Z")
	if g := Start(Week, now); !g.Equal(ts("2026-11-16T00:00:00Z")) {
		t.Fatalf("week start %v", g)
	}
	if g := Start(Week, ts("2026-11-22T12:00:00Z")); !g.Equal(ts("2026-11-16T00:00:00Z")) {
		t.Fatalf("sunday week start %v", g)
	}
}

func TestParse(t *testing.T) {
	got, err := Parse([]byte("budgets:\n  - scope: team:alpha\n    limit_usd: 50\n    period: week\n    alert_percent: 70\n"))
	if err != nil || len(got) != 1 || got[0].Period != Week || got[0].AlertPercent != 70 {
		t.Fatalf("got %+v err %v", got, err)
	}
	for _, bad := range []string{
		"budgets:\n  - scope: alpha\n    limit_usd: 5\n    period: day\n",
		"budgets:\n  - scope: team:a\n    limit_usd: 0\n    period: day\n",
		"budgets:\n  - scope: team:a\n    limit_usd: 5\n    period: year\n",
		"budgets:\n  - scope: team:a\n    limit_usd: 5\n    period: day\n    nope: 1\n",
		"budgets:\n  - {scope: team:a, limit_usd: 5, period: day}\n  - {scope: team:a, limit_usd: 5, period: day}\n",
	} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("want error for %q", bad)
		}
	}
	if b, err := Load(t.TempDir() + "/none.yaml"); err != nil || b != nil {
		t.Fatalf("missing file: %v %v", b, err)
	}
}

func TestAllow(t *testing.T) {
	if err := Allow("team:alpha"); err != nil {
		t.Fatalf("unconfigured must allow: %v", err)
	}
	now := ts("2026-11-19T12:00:00Z")
	Configure(&Guard{
		Budgets: func() ([]Budget, error) {
			return []Budget{{Scope: "team:alpha", LimitUSD: 10, Period: Day}, {Scope: "team:beta", LimitUSD: 10, Period: Day}}, nil
		},
		Rows: func() ([]Row, error) { return []Row{{Team: "alpha", At: now.Add(-time.Hour), CostUSD: 12}}, nil },
		Now:  func() time.Time { return now },
	})
	defer Configure(nil)
	if err := Allow("team:alpha"); !errors.Is(err, ErrOverBudget) {
		t.Fatalf("alpha: %v", err)
	}
	if err := Allow("team:beta"); err != nil {
		t.Fatalf("beta: %v", err)
	}
	if err := Allow("team:none"); err != nil {
		t.Fatalf("no budget must allow: %v", err)
	}
}
