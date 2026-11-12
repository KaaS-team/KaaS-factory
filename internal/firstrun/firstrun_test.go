package firstrun

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api/porttest"
)

// fakeAuditor puts an `auditor` script on PATH that prints the fixture, and logs its argv.
func fakeAuditor(t *testing.T) (log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "argv.log")
	fixture, _ := filepath.Abs("testdata/audit.json")
	script := "#!/bin/sh\necho \"$@\" >> " + log + "\ncat " + fixture + "\n"
	if err := os.WriteFile(filepath.Join(dir, "auditor"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

func TestReportTopRisksAndRows(t *testing.T) {
	fakeAuditor(t)
	r, err := Run(context.Background(), Options{DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	md, err := r.Markdown()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"## Top 3 risks", "config/app.env:7", ".github/workflows/ci.yml:1", "package.json:22", "## What the factory would fix", "## 30/60/90"} {
		if !strings.Contains(md, want) {
			t.Errorf("report lacks %q:\n%s", want, md)
		}
	}
	table := md[strings.Index(md, "## What the factory would fix"):]
	table = table[:strings.Index(table, "## Not covered")]
	if n := strings.Count(table, "\n| ") - 1; n != 4 { // minus header row
		t.Errorf("table rows = %d, want 4 (one per mapped finding):\n%s", n, table)
	}
}

func TestEveryFixtureIDMapsExceptUnmapped(t *testing.T) {
	fakeAuditor(t)
	r, err := Run(context.Background(), Options{DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.NotCovered) != 1 || r.NotCovered[0].ID != "perf.slow-query" {
		t.Fatalf("NotCovered = %+v", r.NotCovered)
	}
	md, _ := r.Markdown()
	if !strings.Contains(md, "## Not covered") || !strings.Contains(md, "perf.slow-query") {
		t.Errorf("report omits Not covered:\n%s", md)
	}
	cat, err := LoadCatalogue()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range r.Rows {
		if cat.Packs[row.Finding.ID].Pack == "" {
			t.Errorf("%s has no pack", row.Finding.ID)
		}
	}
}

func TestPickRule(t *testing.T) {
	row := func(id, risk string, gain int) Row {
		return Row{Finding: Finding{ID: id, ScoreGain: gain}, Risk: risk}
	}
	tests := []struct {
		name string
		rows []Row
		want string // empty means nil
	}{
		{"no rows", nil, ""},
		{"lowest risk wins over gain", []Row{row("a", "high", 9), row("b", "low", 1)}, "b"},
		{"medium beats high", []Row{row("a", "high", 5), row("b", "medium", 1)}, "b"},
		{"same risk, highest gain", []Row{row("a", "low", 3), row("b", "low", 8)}, "b"},
		{"full tie, lowest id", []Row{row("z", "low", 3), row("a", "low", 3)}, "a"},
		{"unknown risk ranks last", []Row{row("a", "weird", 9), row("b", "high", 1)}, "b"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Pick(tc.rows)
			if tc.want == "" {
				if got != nil {
					t.Fatalf("got %v, want nil", got)
				}
				return
			}
			if got == nil || got.Finding.ID != tc.want {
				t.Fatalf("got %v, want %s", got, tc.want)
			}
		})
	}
}

func TestMissingAuditorNamesInstall(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // no auditor anywhere
	_, err := Run(context.Background(), Options{})
	cat, _ := LoadCatalogue()
	if err == nil || !strings.Contains(err.Error(), cat.Auditor.Install) {
		t.Fatalf("err = %v, want install command %q", err, cat.Auditor.Install)
	}
}

func TestDryRunDispatchesNothing(t *testing.T) {
	fakeAuditor(t)
	d := porttest.NewDispatcher(1)
	r, err := Run(context.Background(), Options{DryRun: true, Dispatcher: d})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Sessions) != 0 || r.First != nil || r.Command != "" {
		t.Fatalf("dry run acted: sessions=%d first=%v", len(d.Sessions), r.First)
	}
}

func TestNonDryRunNamesFirstFixButDispatchesNothing(t *testing.T) {
	fakeAuditor(t)
	d := porttest.NewDispatcher(1)
	r, err := Run(context.Background(), Options{Dispatcher: d})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Sessions) != 0 {
		t.Fatal("dispatched")
	}
	// low risk, then highest gain: secrets-scan (8) beats pin/agents-md (3).
	if r.First == nil || r.First.Finding.ID != "sec.secrets-in-repo" || !strings.Contains(r.Command, "sec.secrets-in-repo") {
		t.Fatalf("first = %+v command = %q", r.First, r.Command)
	}
}

func TestGHFlagRunsSecondAudit(t *testing.T) {
	log := fakeAuditor(t)
	if _, err := Run(context.Background(), Options{DryRun: true, GH: "o/r"}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(log)
	if !strings.Contains(string(b), "audit --json --gh o/r") || strings.Count(string(b), "\n") != 2 {
		t.Fatalf("argv log:\n%s", b)
	}
}

func TestScoreAfterCapsAt100(t *testing.T) {
	cat, _ := LoadCatalogue()
	r := Build(Audit{Score: 95, Findings: []Finding{{ID: "sec.secrets-in-repo", ScoreGain: 8}}}, cat)
	if r.ScoreAfter != 100 || r.Rows[0].ScoreAfter != 100 {
		t.Fatalf("%+v", r)
	}
}

func TestCommandPrintsReport(t *testing.T) {
	fakeAuditor(t)
	var out bytes.Buffer
	c := NewCommand()
	c.SetOut(&out)
	c.SetArgs([]string{"--dry-run"})
	if err := c.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "## Top 3 risks") || strings.Contains(out.String(), "## First fix") {
		t.Fatalf("out:\n%s", out.String())
	}
}
