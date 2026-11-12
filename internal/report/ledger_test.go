package report

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/store"
)

type memThread struct{ body string }

func (m *memThread) SpendComment(context.Context, api.TicketID) (string, error) { return m.body, nil }
func (m *memThread) PutSpendComment(_ context.Context, _ api.TicketID, b string) error {
	m.body = b
	return nil
}

// Two attempts written to the ledger, a merged ticket in the store: `factory report` prints the
// ledger's tokens per merged PR (1 PR, 100+40 and 30+10 tokens = 180).
func TestCommandPrintsTokensFromLedger(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "r.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.PutTicket(ctx, api.Ticket{ID: "7", Repo: "o/r", Workflow: "build", Labels: []string{"team:alpha"}}); err != nil {
		t.Fatal(err)
	}
	merged := time.Now().Add(-time.Hour)
	if err := st.RecordThread(ctx, "7", store.Thread{FirstDispatch: merged.Add(-time.Hour), MergedAt: merged}); err != nil {
		t.Fatal(err)
	}
	led := meter.Ledger{Thread: &memThread{}, Holder: "alpha"}
	for n, u := range map[int]api.Usage{1: {InputTokens: 100, OutputTokens: 40}, 2: {InputTokens: 30, OutputTokens: 10}} {
		if err := led.Add(ctx, "7", n, u, u); err != nil {
			t.Fatal(err)
		}
	}
	cmd := NewCommand(WithSource(func(context.Context) (Source, error) {
		return StoreSource{Store: st, Ledger: led}, nil
	}))
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"--json"})
	if err := cmd.ExecuteContext(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"tokens_per_merged_pr": 180`) || !strings.Contains(out.String(), `"merged_prs": 1`) {
		t.Fatalf("out = %s", out.String())
	}
}
