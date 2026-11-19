package eval

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

// Pinned ids: SplitOf must give these answers on every run and every machine.
func TestSplitIsStableAcrossRuns(t *testing.T) {
	want := map[string]Split{}
	for i := 0; i < 200; i++ {
		id := "fx/" + strings.Repeat("a", i%7) + string(rune('0'+i%10)) + string(rune('a'+i%26))
		want[id] = SplitOf(id)
	}
	for round := 0; round < 3; round++ {
		for id, w := range want {
			if got := SplitOf(id); got != w {
				t.Fatalf("SplitOf(%q) = %s, was %s", id, got, w)
			}
		}
	}
	pinned := map[string]Split{"splitbill/1": SplitHoldout, "splitbill/2": SplitHoldout, "bun-add/1": SplitDev, "go-stack/1": SplitDev}
	holdout := 0
	for i := 0; i < 1000; i++ {
		if SplitOf(string(rune('A'+i%26))+"/"+strings.Repeat("x", i%13)+string(rune('0'+i%10))+string(rune(0x100+i))) == SplitHoldout {
			holdout++
		}
	}
	if holdout < 150 || holdout > 250 {
		t.Fatalf("holdout share %d of 1000, want about 20%%", holdout)
	}
	for id, w := range pinned {
		if got := SplitOf(id); got != w {
			t.Fatalf("pinned %q: %s, want %s", id, got, w)
		}
	}
}

func holdoutMatrix(t *testing.T) Matrix {
	t.Helper()
	m := Matrix{}
	for _, n := range []string{"alpha", "beta", "gamma", "delta"} {
		f := Fixture{Name: n}
		for i := 1; i <= 8; i++ {
			f.Tickets = append(f.Tickets, FixtureTicket{Ticket: api.Ticket{ID: api.TicketID(string(rune('0' + i)))}})
		}
		m.Fixtures = append(m.Fixtures, f)
	}
	return m
}

func TestFilterMatrixKeepsSplitsApart(t *testing.T) {
	m := holdoutMatrix(t)
	dev, hold := FilterMatrix(m, SplitDev), FilterMatrix(m, SplitHoldout)
	var nd, nh int
	for _, f := range dev.Fixtures {
		for _, ft := range f.Tickets {
			nd++
			if SplitOf(SampleID(f.Name, ft.ID)) == SplitHoldout {
				t.Fatalf("dev matrix holds holdout sample %s/%s", f.Name, ft.ID)
			}
		}
	}
	for _, f := range hold.Fixtures {
		nh += len(f.Tickets)
	}
	if nh == 0 || nd+nh != 32 {
		t.Fatalf("dev %d holdout %d, want them to cover 32 with a non-empty holdout", nd, nh)
	}
}

type recorder struct {
	mu   sync.Mutex
	seen []api.TicketID
}

func (r *recorder) Dispatch(_ context.Context, t api.Ticket) (Outcome, error) {
	r.mu.Lock()
	r.seen = append(r.seen, t.ID)
	r.mu.Unlock()
	return Outcome{Attempts: 1}, nil
}
func (r *recorder) Gate(context.Context, api.Ticket) (bool, error)               { return true, nil }
func (r *recorder) HiddenTest(context.Context, api.Ticket, string) (bool, error) { return true, nil }

// writeBigFixture writes one fixture of 40 tickets, enough that the holdout is not empty.
func writeBigFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	var ts []string
	for i := 1; i <= 40; i++ {
		ts = append(ts, fmt.Sprintf(`{"id":"t%d","repo":"big","title":"t","body":"b"}`, i))
	}
	if err := os.MkdirAll(filepath.Join(dir, "big"), 0o755); err != nil {
		t.Fatal(err)
	}
	doc := `{"name":"big","hidden":"true","tickets":[` + strings.Join(ts, ",") + `]}`
	if err := os.WriteFile(filepath.Join(dir, "big", "fixture.yaml"), []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// Dev runs, and a run with no --split, never score a holdout sample; --split holdout scores only those.
func TestDevRunNeverLoadsHoldoutSample(t *testing.T) {
	fx := writeBigFixture(t)
	m, err := LoadMatrix(fx)
	if err != nil {
		t.Fatal(err)
	}
	nHold := 0
	for _, f := range FilterMatrix(m, SplitHoldout).Fixtures {
		nHold += len(f.Tickets)
	}
	if nHold == 0 || nHold == 40 {
		t.Fatalf("holdout has %d of 40", nHold)
	}
	for _, c := range []struct {
		args    []string
		holdout bool
		want    int
	}{{nil, false, 40 - nHold}, {[]string{"--split", "dev"}, false, 40 - nHold}, {[]string{"--split", "holdout"}, true, nHold}} {
		out := t.TempDir()
		runner := func(context.Context, string, string, string) (Deps, error) { return &recorder{}, nil }
		cmd := NewCommand(WithRunner(runner))
		cmd.SetOut(&strings.Builder{})
		cmd.SetArgs(append([]string{"run", "--workflow", "default", "--agent", "claude", "--fixtures", fx, "--out", out}, c.args...))
		if err := cmd.ExecuteContext(context.Background()); err != nil {
			t.Fatal(err)
		}
		files, _ := filepath.Glob(filepath.Join(out, "*.json"))
		sc, err := readScorecard(files[0])
		if err != nil {
			t.Fatal(err)
		}
		if len(sc.Tickets) != c.want {
			t.Fatalf("args %v: %d tickets, want %d", c.args, len(sc.Tickets), c.want)
		}
		for _, r := range sc.Tickets {
			if (SplitOf(SampleID(r.Fixture, r.Ticket)) == SplitHoldout) != c.holdout {
				t.Fatalf("args %v scored %s/%s from the wrong split", c.args, r.Fixture, r.Ticket)
			}
		}
	}
}

func TestHoldoutNeedsExplicitFlag(t *testing.T) {
	cmd := NewCommand(WithRunner(func(context.Context, string, string, string) (Deps, error) { return &recorder{}, nil }))
	cmd.SetArgs([]string{"run", "--workflow", "default", "--agent", "claude", "--fixtures", fixturesDir, "--out", t.TempDir(), "--split", "all"})
	if err := cmd.ExecuteContext(context.Background()); err == nil || !strings.Contains(err.Error(), "--split") {
		t.Fatalf("want a --split error, got %v", err)
	}
}

func TestSplitReportGolden(t *testing.T) {
	var rs []TicketResult
	for _, id := range []string{"a/1", "a/2", "a/3", "b/1", "b/2", "b/3", "b/4", "c/1", "c/2", "c/3"} {
		f, tk, _ := strings.Cut(id, "/")
		rs = append(rs, TicketResult{Fixture: f, Ticket: api.TicketID(tk), Merged: SplitOf(id) == SplitHoldout || tk != "3"})
	}
	goldenCheck(t, "split-report.golden", SplitReport(Scorecard{Tickets: rs}))
}

func TestSplitReportCommandReadsScorecards(t *testing.T) {
	dir := t.TempDir()
	sc := Scorecard{Schema: SchemaV1, Tickets: []TicketResult{{Fixture: "a", Ticket: "1", Merged: true}}}
	p := filepath.Join(dir, "s.json")
	if err := writeScorecard(strings.TrimSuffix(p, ".json"), sc); err != nil {
		t.Fatal(err)
	}
	cmd := NewCommand()
	var out strings.Builder
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"splits", p})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "| Split |") {
		t.Fatalf("output %q", out.String())
	}
	_ = os.Remove(p)
}
