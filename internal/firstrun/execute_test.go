package firstrun

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
)

type fakePRs struct {
	calls []prCall
	err   error
}

type prCall struct{ Branch, Base, Title, Body string }

func (f *fakePRs) OpenDraft(_ context.Context, branch, base, title, body string) (int, error) {
	f.calls = append(f.calls, prCall{branch, base, title, body})
	return 7, f.err
}

func row(id, risk string, gain int, size string) Row {
	return Row{Finding: Finding{ID: id, Title: "Fix " + id, ScoreGain: gain, File: "a.go"}, Pack: "hygiene", Size: size, Risk: risk, Tokens: 150000, Minutes: 10}
}

// TestPickTable is the risk x value table: the lowest risk wins, then the highest gain (Symphony §8.2 order of dispatch).
func TestPickTable(t *testing.T) {
	tests := []struct {
		name string
		rows []Row
		want string
	}{
		{"low risk low gain beats high risk high gain", []Row{row("big", "high", 9, "S"), row("small", "low", 1, "S")}, "small"},
		{"low risk, higher gain", []Row{row("a", "low", 2, "S"), row("b", "low", 5, "M")}, "b"},
		{"medium over high", []Row{row("a", "high", 9, "S"), row("b", "medium", 2, "S")}, "b"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Pick(tc.rows); got == nil || got.Finding.ID != tc.want {
				t.Fatalf("got %v want %s", got, tc.want)
			}
		})
	}
}

func report2(rows ...Row) Report { return Report{Score: 50, Rows: rows, First: Pick(rows)} }

func TestExecuteDispatchesOneBriefAndOpensOneDraftPR(t *testing.T) {
	d := porttest.NewDispatcher(1)
	d.UsageBy["first-run-low-a1"] = api.Usage{InputTokens: 1000, OutputTokens: 500, WallTime: 3 * time.Minute}
	prs := &fakePRs{}
	rep := report2(row("high-risk", "high", 9, "S"), row("low", "low", 1, "S"))
	res, err := Execute(context.Background(), rep, Exec{Dispatcher: d, PRs: prs, Repo: "o/r", Base: "main", Branch: "factory/first-run-low-a1", Model: "claude-x"})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Sessions) != 1 || len(prs.calls) != 1 || res.PR != 7 {
		t.Fatalf("sessions=%d prs=%d res=%+v", len(d.Sessions), len(prs.calls), res)
	}
	body := prs.calls[0].Body
	for _, bad := range []string{"token", "cost", "$", "claude", "model", "150000", "1000"} {
		if strings.Contains(strings.ToLower(body), bad) {
			t.Errorf("PR body contains %q:\n%s", bad, body)
		}
	}
	if !strings.Contains(body, "low") {
		t.Errorf("body does not name the finding:\n%s", body)
	}
}

func TestExecuteBriefAsksForFreshSessionVerify(t *testing.T) {
	d := porttest.NewDispatcher(1)
	var got api.Brief
	rec := &recordingDispatcher{Dispatcher: d, got: &got}
	_, err := Execute(context.Background(), report2(row("low", "low", 1, "S")), Exec{Dispatcher: rec, PRs: &fakePRs{}, Repo: "o/r", Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.Text, "fresh session") || got.Attempt != 1 || got.Repo != "o/r" || got.Base != "main" {
		t.Fatalf("brief %+v", got)
	}
}

type recordingDispatcher struct {
	*porttest.Dispatcher
	got *api.Brief
}

func (r *recordingDispatcher) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	*r.got = b
	return r.Dispatcher.Dispatch(ctx, b)
}

func TestExecuteDryRunDispatchesNothingAndSaysWhat(t *testing.T) {
	d := porttest.NewDispatcher(1)
	prs := &fakePRs{}
	rep := report2(row("low", "low", 1, "S"))
	rep.DryRun = true
	res, err := Execute(context.Background(), rep, Exec{Dispatcher: d, PRs: prs})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Sessions) != 0 || len(prs.calls) != 0 || !strings.Contains(res.Plan, "Would dispatch one build for low") {
		t.Fatalf("sessions=%d prs=%d plan=%q", len(d.Sessions), len(prs.calls), res.Plan)
	}
}

func TestExecuteNothingCoveredDispatchesNothing(t *testing.T) {
	d := porttest.NewDispatcher(1)
	if _, err := Execute(context.Background(), Report{}, Exec{Dispatcher: d, PRs: &fakePRs{}}); err == nil || len(d.Sessions) != 0 {
		t.Fatalf("err=%v sessions=%d", err, len(d.Sessions))
	}
}

func TestExecuteDispatchErrorOpensNoPR(t *testing.T) {
	d := porttest.NewDispatcher(1)
	d.Err = errors.New("boom")
	prs := &fakePRs{}
	if _, err := Execute(context.Background(), report2(row("low", "low", 1, "S")), Exec{Dispatcher: d, PRs: prs}); err == nil || len(prs.calls) != 0 {
		t.Fatalf("err=%v prs=%d", err, len(prs.calls))
	}
}

// TestScorecardMissingActualIsNotMeasured: a zero usage is unknown, never 0.
func TestScorecardMissingActualIsNotMeasured(t *testing.T) {
	tests := []struct {
		name       string
		usage      api.Usage
		wantTokens string
		wantWall   string
	}{
		{"measured", api.Usage{InputTokens: 900, OutputTokens: 100, WallTime: 4 * time.Minute}, "1000", "4"},
		{"unmeasured", api.Usage{}, `"not measured"`, `"not measured"`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := porttest.NewDispatcher(1)
			d.UsageBy["first-run-low-a1"] = tc.usage
			res, err := Execute(context.Background(), report2(row("low", "low", 1, "S")), Exec{Dispatcher: d, PRs: &fakePRs{}})
			if err != nil {
				t.Fatal(err)
			}
			raw, err := res.Scorecard.JSON()
			if err != nil {
				t.Fatal(err)
			}
			var top map[string]json.RawMessage
			if err := json.Unmarshal(raw, &top); err != nil {
				t.Fatal(err)
			}
			m := map[string]map[string]json.RawMessage{}
			for _, k := range []string{"estimate", "actual", "gates"} {
				var sub map[string]json.RawMessage
				if err := json.Unmarshal(top[k], &sub); err != nil {
					t.Fatalf("%s: %v in %s", k, err, raw)
				}
				m[k] = sub
			}
			if string(m["estimate"]["tokens"]) != "150000" || string(m["actual"]["tokens"]) != tc.wantTokens || string(m["actual"]["minutes"]) != tc.wantWall {
				t.Fatalf("scorecard %s", raw)
			}
			if string(m["gates"]["green"]) != `"not measured"` || string(top["human_touches"]) != `"not measured"` {
				t.Fatalf("scorecard %s", raw)
			}
		})
	}
}
