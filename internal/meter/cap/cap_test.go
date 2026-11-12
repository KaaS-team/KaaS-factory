package cap_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/meter/cap"
)

func rig(t *testing.T, usd float64, id api.TicketID, spent float64) (cap.Gate, *porttest.Tracker) {
	t.Helper()
	tr := porttest.NewTracker()
	if spent > 0 {
		tr.Spend[id] = meter.EncodeSpend(meter.Spend{Holder: "alpha", CostUSD: spent, Runs: 1,
			Attempts: []meter.AttemptTokens{{N: 1, Input: 10, Output: 5}}})
	}
	return cap.Gate{Thread: tr, Holder: "alpha", USD: usd}, tr
}

// Symphony 13.5 (spend is read from the ledger): every branch of the pre-dispatch decision.
func TestAllow(t *testing.T) {
	for _, c := range []struct {
		name  string
		usd   float64
		spent float64
		over  bool
	}{
		{"no cap set", 0, 99, false},
		{"nothing spent", 5, 0, false},
		{"under the cap", 5, 4.99, false},
		{"exactly at the cap", 5, 5, true},
		{"over the cap", 5, 7.5, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			g, _ := rig(t, c.usd, "a", c.spent)
			err := g.Allow(context.Background(), "a")
			if got := errors.Is(err, cap.ErrOverCap); got != c.over {
				t.Fatalf("Allow = %v, want over=%v", err, c.over)
			}
		})
	}
}

// The reason a customer can see names no cost, token count or model.
func TestRefusalNamesNoCost(t *testing.T) {
	g, _ := rig(t, 5, "a", 7.5)
	err := g.Allow(context.Background(), "a")
	if err == nil {
		t.Fatal("want a refusal")
	}
	for _, bad := range []string{"7.5", "5", "$", "usd", "USD", "token", "model"} {
		if strings.Contains(err.Error(), bad) {
			t.Fatalf("refusal %q names %q", err, bad)
		}
	}
}

// The cap and the spend are written to the ledger comment, once per change.
func TestLedgerWritten(t *testing.T) {
	g, tr := rig(t, 5, "a", 2)
	ctx := context.Background()
	if err := g.Allow(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	body := tr.Spend["a"]
	rec, ok := cap.Read(body)
	if !ok || rec.CapUSD != 5 || rec.SpentUSD != 2 {
		t.Fatalf("cap record = %+v ok=%v in %q", rec, ok, body)
	}
	if s, err := meter.DecodeSpend(body); err != nil || len(s) != 1 || s[0].CostUSD != 2 {
		t.Fatalf("spend marker damaged: %+v %v", s, err)
	}
	if err := g.Allow(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if strings.Count(tr.Spend["a"], "factory:cap") != 1 {
		t.Fatalf("cap marker repeated: %q", tr.Spend["a"])
	}
}

// A ledger rewrite by the meter keeps the cap marker.
func TestLedgerAddKeepsCap(t *testing.T) {
	g, tr := rig(t, 5, "a", 2)
	ctx := context.Background()
	if err := g.Allow(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	l := meter.Ledger{Thread: tr, Holder: "alpha"}
	if err := l.Add(ctx, "a", 2, api.Usage{InputTokens: 50, OutputTokens: 5}, api.Usage{CostUSD: 1}); err != nil {
		t.Fatal(err)
	}
	if _, ok := cap.Read(tr.Spend["a"]); !ok {
		t.Fatalf("cap marker lost: %q", tr.Spend["a"])
	}
}

// Concurrent sessions: each ticket is judged on its own spend, none leaks into another.
func TestConcurrentSessions(t *testing.T) {
	tr := porttest.NewTracker()
	const n = 40
	for i := range n {
		id := api.TicketID(fmt.Sprintf("t%d", i))
		cost := 1.0
		if i%2 == 0 {
			cost = 9
		}
		tr.Spend[id] = meter.EncodeSpend(meter.Spend{Holder: "alpha", CostUSD: cost, Runs: 1,
			Attempts: []meter.AttemptTokens{{N: 1, Input: 1}}})
	}
	g := cap.Gate{Thread: tr, Holder: "alpha", USD: 5}
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = g.Allow(context.Background(), api.TicketID(fmt.Sprintf("t%d", i)))
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if over := errors.Is(err, cap.ErrOverCap); over != (i%2 == 0) {
			t.Fatalf("t%d: err=%v", i, err)
		}
	}
}

// Another holder's ledger row does not count against this holder's cap.
func TestOtherHolderIgnored(t *testing.T) {
	g, tr := rig(t, 5, "a", 0)
	tr.Spend["a"] = meter.EncodeSpend(meter.Spend{Holder: "beta", CostUSD: 50, Runs: 1})
	if err := g.Allow(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
}
