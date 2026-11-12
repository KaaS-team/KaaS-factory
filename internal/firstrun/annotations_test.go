package firstrun

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/firstrun/sarif"
)

const annotationsYAML = "annotations:\n  - checks: [actions-pinned-sha]\n    reasons:\n      - reason: remediated\n"

func cfg(t *testing.T, y string) sarif.Config {
	t.Helper()
	c, err := sarif.ParseAnnotations(strings.NewReader(y))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSuppressionLeavesScoreAndShowsReason(t *testing.T) {
	fakeAuditor(t)
	base, err := Run(context.Background(), Options{DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	r, err := Run(context.Background(), Options{DryRun: true, Annotations: cfg(t, annotationsYAML)})
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range r.Rows {
		if w.Finding.ID == "actions-pinned-sha" {
			t.Error("a suppressed finding is still a row to fix")
		}
	}
	for _, f := range r.TopRisks {
		if f.ID == "actions-pinned-sha" {
			t.Error("a suppressed finding is still a top risk")
		}
	}
	if len(r.Rows) != len(base.Rows)-1 {
		t.Errorf("rows = %d, want %d", len(r.Rows), len(base.Rows)-1)
	}
	if r.Score != base.Score+1 {
		t.Errorf("score = %d, want %d: a suppressed finding counts as satisfied", r.Score, base.Score+1)
	}
	if r.ScoreAfter != base.ScoreAfter {
		t.Errorf("projected score = %d, want %d: the suppressed gain is already in Score", r.ScoreAfter, base.ScoreAfter)
	}
	md, err := r.Markdown()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(md, "## Suppressed") || !strings.Contains(md, "actions-pinned-sha") || !strings.Contains(md, "remediated") {
		t.Errorf("report does not show the suppression and its reason:\n%s", md)
	}
	if bmd, _ := base.Markdown(); strings.Contains(bmd, "## Suppressed") {
		t.Error("report without annotations has a Suppressed section")
	}
}

func TestSARIFOfReport(t *testing.T) {
	fakeAuditor(t)
	r, err := Run(context.Background(), Options{DryRun: true, Annotations: cfg(t, annotationsYAML)})
	if err != nil {
		t.Fatal(err)
	}
	out, err := r.SARIF("test")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Runs []struct {
			Results []struct {
				RuleID       string
				Suppressions []any
			}
		}
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	var n, sup int
	for _, x := range doc.Runs[0].Results {
		n++
		if len(x.Suppressions) > 0 {
			sup++
			if x.RuleID != "actions-pinned-sha" {
				t.Errorf("suppressed %s", x.RuleID)
			}
		}
	}
	if want := len(r.Rows) + len(r.NotCovered) + 1; n != want || sup != 1 {
		t.Errorf("results %d (want %d), suppressed %d (want 1)", n, want, sup)
	}
}

func TestCommandFlags(t *testing.T) {
	fakeAuditor(t)
	dir := t.TempDir()
	ann := filepath.Join(dir, "a.yml")
	out := filepath.Join(dir, "out.sarif")
	if err := os.WriteFile(ann, []byte(annotationsYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) (string, error) {
		c := NewCommand()
		var b bytes.Buffer
		c.SetOut(&b)
		c.SetErr(&b)
		c.SetArgs(args)
		err := c.Execute()
		return b.String(), err
	}
	md, err := run("--dry-run", "--annotations", ann, "--sarif", out)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(md, "## Suppressed") {
		t.Errorf("--annotations had no effect:\n%s", md)
	}
	if b, err := os.ReadFile(out); err != nil || !strings.Contains(string(b), `"version": "2.1.0"`) {
		t.Errorf("--sarif wrote %q, %v", b, err)
	}
	if _, err := run("--dry-run", "--annotations", filepath.Join(dir, "missing.yml")); err == nil {
		t.Error("an explicit --annotations file that is missing must be an error")
	}
	// The default path is optional: a repo with no annotations file still runs.
	t.Chdir(dir)
	if _, err := run("--dry-run"); err != nil {
		t.Errorf("missing default annotations file: %v", err)
	}
}

func TestRunNoSuppressionWithoutAnnotations(t *testing.T) {
	fakeAuditor(t)
	r, err := Run(context.Background(), Options{DryRun: true})
	if err != nil || len(r.Suppressed) != 0 {
		t.Fatalf("suppressed = %v, err = %v", r.Suppressed, err)
	}
}
