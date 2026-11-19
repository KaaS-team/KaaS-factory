package report

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBudgetGolden(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".factory"), 0o755); err != nil {
		t.Fatal(err)
	}
	yml := filepath.Join(dir, ".factory", "budgets.yaml")
	if err := os.WriteFile(yml, []byte(`budgets:
  - scope: team:alpha
    limit_usd: 5
    period: month
    alert_percent: 50
  - scope: team:beta
    limit_usd: 10
    period: month
  - scope: client:acme
    limit_usd: 3
    period: month
`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	// now is hour 240 of the fixture clock; see at().
	recs := fixture()
	recs[0].Client = "acme"
	cmd := NewCommand(
		WithSource(func(context.Context) (Source, error) { return &fakeSource{recs: recs}, nil }),
		WithNow(func() time.Time { return at(24 * 10) }),
	)
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"--budget", "--json"})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join(wd, "testdata", "budget.golden.json")
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.WriteFile(golden, out.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if out.String() != string(want) {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
}
