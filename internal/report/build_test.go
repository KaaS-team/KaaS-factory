package report

import (
	"context"
	"errors"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

type fakeSource struct {
	recs []TicketRecord
	err  error
	got  Window
}

func (f *fakeSource) Tickets(_ context.Context, w Window) ([]TicketRecord, error) {
	f.got = w
	return f.recs, f.err
}

func use(in, out int64, usd float64) api.Usage {
	return api.Usage{InputTokens: in, OutputTokens: out, CostUSD: usd}
}

var win = Window{Since: at(0), Until: at(1000)}

// fixture: two teams, three workflows, two packs.
//
//	A  alpha build  go   merged, 2 attempts (1000+500, 400+100)=2000 tokens, $3, 1 chatops + 2 pushes, 10h
//	B  alpha build  go   merged, 1 attempt  600 tokens, $1, 0 touches, 4h
//	C  beta  fix    web  merged, 1 attempt  1400 tokens, $2, 1 chatops, 6h
//	D  beta  fix    web  never merged, 2 attempts 700+300 = 1000 tokens, $1.5
//	E  alpha build  go   merged before window: not a merged PR, spend still counted
func fixture() []TicketRecord {
	return []TicketRecord{
		{ID: "A", Team: "alpha", Workflow: "build", Pack: "go", FirstDispatch: at(1), MergedAt: at(11), ChatopsCommands: 1, ManualPushes: 2,
			Attempts: []Attempt{{N: 1, Usage: use(1000, 500, 2)}, {N: 2, Usage: use(400, 100, 1)}}},
		{ID: "B", Team: "alpha", Workflow: "build", Pack: "go", FirstDispatch: at(2), MergedAt: at(6),
			Attempts: []Attempt{{N: 1, Usage: use(500, 100, 1)}}},
		{ID: "C", Team: "beta", Workflow: "fix", Pack: "web", FirstDispatch: at(3), MergedAt: at(9), ChatopsCommands: 1,
			Attempts: []Attempt{{N: 1, Usage: use(1000, 400, 2)}}},
		{ID: "D", Team: "beta", Workflow: "fix", Pack: "web", FirstDispatch: at(4),
			Attempts: []Attempt{{N: 1, Usage: use(500, 200, 1)}, {N: 2, Usage: use(200, 100, 0.5)}}},
		{ID: "E", Team: "alpha", Workflow: "build", Pack: "go", FirstDispatch: at(-50), MergedAt: at(-40),
			Attempts: []Attempt{{N: 1, Usage: use(100, 0, 0.25)}}},
	}
}

func TestBuildTotals(t *testing.T) {
	r, err := Build(context.Background(), &fakeSource{recs: fixture()}, win)
	if err != nil {
		t.Fatal(err)
	}
	got := r.Total
	want := Row{
		Key:            "all",
		MergedPRs:      3,
		MergedTokens:   2000 + 600 + 1400, // 4000, failed attempt of A included
		UnmergedTokens: 1000 + 100,        // D never merged, E merged outside the window
		ReworkAttempts: 1,                 // A has two attempts
		HumanTouches:   4,                 // A 3, C 1
		CostUSD:        3 + 1 + 2 + 1.5 + 0.25,
		CycleSamples:   3,
		CycleSeconds:   (10 + 4 + 6) * 3600,
	}
	if got != want {
		t.Fatalf("row\n got %+v\nwant %+v", got, want)
	}
	if v := got.TokensPerMergedPR(); v != 4000.0/3 {
		t.Fatalf("tokens per merged PR = %v, want %v", v, 4000.0/3)
	}
	if v := got.ReworkRate(); v != 1.0/3 {
		t.Fatalf("rework rate = %v", v)
	}
	if v := got.TouchesPerPR(); v != 4.0/3 {
		t.Fatalf("touches per PR = %v", v)
	}
	if v := got.MeanCycleSeconds(); v != 20*3600/3 {
		t.Fatalf("mean cycle = %v", v)
	}
}

func TestBuildUnmergedAddsSpendNotPRs(t *testing.T) {
	only := fixture()[3:4] // D
	r, err := Build(context.Background(), &fakeSource{recs: only}, win)
	if err != nil {
		t.Fatal(err)
	}
	row := r.Total
	if row.MergedPRs != 0 || row.MergedTokens != 0 || row.UnmergedTokens != 1000 || row.CostUSD != 1.5 {
		t.Fatalf("row = %+v", row)
	}
	if row.TokensPerMergedPR() != 0 || row.ReworkRate() != 0 || row.TouchesPerPR() != 0 || row.MeanCycleSeconds() != 0 {
		t.Fatalf("per-PR figures must be 0 with no merged PRs: %+v", row)
	}
}

func TestBuildGroups(t *testing.T) {
	for _, c := range []struct {
		by   GroupBy
		keys []string
	}{
		{ByTeam, []string{"alpha", "beta"}},
		{ByWorkflow, []string{"build", "fix"}},
		{ByPack, []string{"go", "web"}},
	} {
		t.Run(string(c.by), func(t *testing.T) {
			r, err := Build(context.Background(), &fakeSource{recs: fixture()}, win)
			if err != nil {
				t.Fatal(err)
			}
			rows := r.Rows(c.by)
			if len(rows) != 2 || rows[0].Key != c.keys[0] || rows[1].Key != c.keys[1] {
				t.Fatalf("rows = %+v", rows)
			}
			if r.Total.MergedPRs != 3 || r.Total.MergedTokens != 4000 {
				t.Fatalf("total = %+v", r.Total)
			}
		})
	}
}

func TestBuildEmptyKeyIsNone(t *testing.T) {
	r, _ := Build(context.Background(), &fakeSource{recs: []TicketRecord{{ID: "X"}}}, win)
	if r.Rows(ByPack)[0].Key != "(none)" {
		t.Fatalf("key = %q", r.Rows(ByPack)[0].Key)
	}
}

func TestBuildErrors(t *testing.T) {
	boom := errors.New("boom")
	if _, err := Build(context.Background(), &fakeSource{err: boom}, win); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if got := (Report{}).Rows(GroupBy("zzz")); got != nil {
		t.Fatalf("unknown group rows = %v", got)
	}
	if _, err := Build(context.Background(), &fakeSource{}, Window{Since: at(5), Until: at(5)}); err == nil {
		t.Fatal("empty window must fail")
	}
}

func TestBuildPassesWindow(t *testing.T) {
	f := &fakeSource{}
	_, _ = Build(context.Background(), f, win)
	if f.got != win {
		t.Fatalf("window = %+v", f.got)
	}
}
