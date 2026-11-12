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
	// report.v1.json is real `auditor report --json .` output (auditor.report/v1), not a guess.
	fixture, _ := filepath.Abs("testdata/report.v1.json")
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
	for _, want := range []string{"## Top 3 risks", "Dockerfile:13", "src/adapters/env/secrets.ts:1", "## What the factory would fix", "## 30/60/90"} {
		if !strings.Contains(md, want) {
			t.Errorf("report lacks %q:\n%s", want, md)
		}
	}
	table := md[strings.Index(md, "## What the factory would fix"):]
	table = table[:strings.Index(table, "## Not covered")]
	if n := strings.Count(table, "\n| ") - 1; n != 13 { // minus header row
		t.Errorf("table rows = %d, want 13 (one per open finding with a pack and effort):\n%s", n, table)
	}
}

// TestRowsComeFromAuditorPacks: passing findings are dropped, open ones with the auditor's pack and
// effort become rows, and open ones without (hotspots, bus-factor) are listed as not covered.
func TestRowsComeFromAuditorPacks(t *testing.T) {
	fakeAuditor(t)
	r, err := Run(context.Background(), Options{DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if r.Score != 82 {
		t.Errorf("score = %d, want scores.overall 82", r.Score)
	}
	var ids []string
	for _, f := range r.NotCovered {
		ids = append(ids, f.ID)
	}
	if strings.Join(ids, ",") != "hotspots,bus-factor" {
		t.Fatalf("NotCovered = %v", ids)
	}
	for _, row := range r.Rows {
		if row.Finding.Severity == "ok" || row.Pack != row.Finding.Pack || row.Size != row.Finding.Effort {
			t.Errorf("row %+v", row)
		}
	}
	md, _ := r.Markdown()
	if !strings.Contains(md, "## Not covered") || !strings.Contains(md, "bus-factor") {
		t.Errorf("report omits Not covered:\n%s", md)
	}
}

func TestWrongSchemaFails(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\necho '{\"score\": 54, \"findings\": []}'\n"
	if err := os.WriteFile(filepath.Join(dir, "auditor"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if _, err := Run(context.Background(), Options{DryRun: true}); err == nil || !strings.Contains(err.Error(), Schema) {
		t.Fatalf("err = %v, want a schema error naming %s", err, Schema)
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
	// Outside any risk area, every gain is 1 in the fixture, so the lowest id wins.
	if r.First == nil || r.First.Finding.ID != "ci-pr-minutes" || !strings.Contains(r.Command, "ci-pr-minutes") {
		t.Fatalf("first = %+v command = %q", r.First, r.Command)
	}
}

func TestGHFlagRunsSecondAudit(t *testing.T) {
	log := fakeAuditor(t)
	if _, err := Run(context.Background(), Options{DryRun: true, GH: "o/r"}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(log)
	if !strings.Contains(string(b), "report --json .\n") || !strings.Contains(string(b), "audit --json --gh o/r .\n") || strings.Count(string(b), "\n") != 2 {
		t.Fatalf("argv log:\n%s", b)
	}
}

func TestScoreAfterCapsAt100(t *testing.T) {
	cat, _ := LoadCatalogue()
	a := Audit{Findings: []Finding{{ID: "env-example", Severity: "warn", Pack: "hygiene", Effort: "S", ScoreGain: 8}}}
	a.Scores.Overall = 95
	r := Build(a, cat)
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
