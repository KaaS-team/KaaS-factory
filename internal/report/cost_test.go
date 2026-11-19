package report

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// costFixture: repo o/a has two merged PRs ($3 and $1 spend, #2 reverted after a day) and an
// unmerged ticket ($1.5); repo o/b has one merged PR reverted after 20 days, so it survives.
func costFixture() []TicketRecord {
	return []TicketRecord{
		{ID: "A", Repo: "o/a", PR: 1, MergedAt: at(10), Attempts: []Attempt{{N: 1, Usage: use(0, 0, 2)}, {N: 2, Usage: use(0, 0, 1)}}},
		{ID: "B", Repo: "o/a", PR: 2, MergedAt: at(20), RevertedAt: at(44), Attempts: []Attempt{{N: 1, Usage: use(0, 0, 1)}}},
		{ID: "D", Repo: "o/a", Attempts: []Attempt{{N: 1, Usage: use(0, 0, 1.5)}}},
		{ID: "C", Repo: "o/b", PR: 3, MergedAt: at(30), RevertedAt: at(30 + 20*24), Attempts: []Attempt{{N: 1, Usage: use(0, 0, 2)}}},
	}
}

func runCost(t *testing.T, args ...string) string {
	t.Helper()
	cmd := NewCommand(
		WithSource(func(context.Context) (Source, error) { return &fakeSource{recs: costFixture()}, nil }),
		WithNow(func() time.Time { return at(24 * 10) }),
	)
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs(args)
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

// The golden file is written by hand from the fixture's numbers, not generated.
func TestCostJSONGolden(t *testing.T) {
	want, err := os.ReadFile("testdata/cost.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	if got := runCost(t, "--cost", "--json", "--since", "30d"); got != string(want) {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestCostMarkdownAndChurn(t *testing.T) {
	out := runCost(t, "--cost", "--since", "30d")
	for _, w := range []string{"| all | 3 | 2 | 0.3333333333333333 | 7.5 | 3.75 |", "| o/a | 2 | 1 | 0.5 | 5.5 | 5.5 |"} {
		if !strings.Contains(out, w) {
			t.Errorf("missing %q in\n%s", w, out)
		}
	}
	// A 30-day churn window makes the 20-day revert of o/b count.
	if out := runCost(t, "--cost", "--json", "--since", "30d", "--churn", "30d"); !strings.Contains(out, `"churn_days": 30`) || !strings.Contains(out, `"surviving": 1,
    "spend_usd": 7.5`) {
		t.Errorf("churn not applied:\n%s", out)
	}
}
