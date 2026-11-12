package meter

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

func newCloud() *CloudUsage {
	return NewCloudUsage(New(Budgets{}, func() time.Time { return time.Unix(1700000000, 0) }))
}

var ck = Key{Team: "t", Ticket: "7", Node: "build", Session: "sess_a"}

func tok(in, out int64, usd float64) *api.Usage {
	return &api.Usage{InputTokens: in, OutputTokens: out, CostUSD: usd}
}

// Symphony §13.5: three polls with growing absolute totals record the deltas
// once, and a repeated poll adds nothing.
func TestCloudPollsRecordDeltasOnce(t *testing.T) {
	c := newCloud()
	polls := []struct {
		total *api.Usage
		delta api.Usage
	}{
		{tok(100, 10, 0.125), api.Usage{InputTokens: 100, OutputTokens: 10, CostUSD: 0.125}},
		{tok(100, 10, 0.125), api.Usage{}},
		{tok(250, 40, 0.375), api.Usage{InputTokens: 150, OutputTokens: 30, CostUSD: 0.25}},
		{tok(250, 40, 0.375), api.Usage{}},
		{tok(400, 90, 0.5), api.Usage{InputTokens: 150, OutputTokens: 50, CostUSD: 0.125}},
	}
	for i, p := range polls {
		d, err := c.Poll(ck, p.total)
		if err != nil || d != p.delta {
			t.Errorf("poll %d: delta %+v %v, want %+v", i, d, err, p.delta)
		}
	}
	if u := c.Meter().Used(ck).Ticket; u.InputTokens != 400 || u.OutputTokens != 90 {
		t.Errorf("ticket total %+v", u)
	}
}

func TestCloudUnknownIsRecordedAsUnknown(t *testing.T) {
	c := newCloud()
	d, err := c.Poll(ck, nil)
	if err != nil || d != (api.Usage{}) {
		t.Fatalf("%+v %v", d, err)
	}
	if !c.Unknown(ck) {
		t.Error("run with no usage is not unknown")
	}
	s := c.Spend("worker-1")
	if s.UnreportedRuns != 1 || s.Runs != 1 {
		t.Errorf("spend %+v", s)
	}
	if enc := EncodeSpend(s); !strings.Contains(enc, `"unreportedRuns":1`) {
		t.Errorf("ledger body %q", enc)
	}
	if got := c.Describe(ck); got != "unknown" {
		t.Errorf("report line %q", got)
	}
	// A later report resolves it; an unknown poll after a known one keeps the totals.
	if _, err := c.Poll(ck, tok(5, 1, 0)); err != nil || c.Unknown(ck) {
		t.Errorf("still unknown after a report: %v", err)
	}
	if _, err := c.Poll(ck, nil); err != nil || c.Unknown(ck) {
		t.Errorf("a missed read hid a known run: %v", err)
	}
	if got := c.Describe(ck); got == "unknown" || !strings.Contains(got, "5") {
		t.Errorf("report line %q", got)
	}
	if s := c.Spend("worker-1"); s.UnreportedRuns != 0 || s.Runs != 1 {
		t.Errorf("spend %+v", s)
	}
}

func TestCloudDecreaseIsRefusedAndTotalsStay(t *testing.T) {
	c := newCloud()
	_, _ = c.Poll(ck, tok(100, 10, 0))
	if _, err := c.Poll(ck, tok(50, 10, 0)); err == nil {
		t.Fatal("decrease accepted")
	}
	if u := c.Meter().Used(ck).Ticket; u.InputTokens != 100 {
		t.Errorf("%+v", u)
	}
}

func TestCloudSpendSumsRunsAndCost(t *testing.T) {
	c := newCloud()
	k2 := Key{Team: "t", Ticket: "8", Node: "build", Session: "sess_b"}
	_, _ = c.Poll(ck, tok(1, 1, 0.25))
	_, _ = c.Poll(k2, nil)
	if s := c.Spend("w"); !reflect.DeepEqual(s, Spend{Holder: "w", CostUSD: 0.25, UnreportedRuns: 1, Runs: 2}) {
		t.Errorf("%+v", s)
	}
}
