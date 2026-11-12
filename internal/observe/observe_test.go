package observe

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

type fakeSource struct {
	branches map[string]time.Time
	prs      map[string]PR
	checks   map[int]Checks
	diff     map[string][]string
	err      error
}

func (f *fakeSource) Branch(_ context.Context, name string) (time.Time, bool, error) {
	t, ok := f.branches[name]
	return t, ok, f.err
}
func (f *fakeSource) PullRequest(_ context.Context, head string) (PR, bool, error) {
	p, ok := f.prs[head]
	return p, ok, f.err
}
func (f *fakeSource) Checks(_ context.Context, pr int) (Checks, error) { return f.checks[pr], f.err }
func (f *fakeSource) DiffFiles(_ context.Context, b string) ([]string, error) {
	return f.diff[b], f.err
}

var pushed = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

// One row per phase outcome (Symphony §8.5: completion is read from git and the tracker).
func TestObserve(t *testing.T) {
	br, rep := "factory/42-a2", "report/42"
	tests := []struct {
		name      string
		src       fakeSource
		wantPhase api.Phase
		wantPR    int
		hasReport bool
		green     *bool // nil, or pointer to expected value
		branch    string
	}{
		{name: "nothing pushed", src: fakeSource{}, wantPhase: api.PhaseReady},
		{name: "report branch without work branch", src: fakeSource{branches: map[string]time.Time{rep: pushed}}, wantPhase: api.PhaseReady, hasReport: true},
		{name: "pushed without report is running", src: fakeSource{branches: map[string]time.Time{br: pushed}, diff: map[string][]string{br: {"a.go"}}}, wantPhase: api.PhaseRunning, branch: br},
		{name: "report without PR is still running", src: fakeSource{branches: map[string]time.Time{br: pushed, rep: pushed}}, wantPhase: api.PhaseRunning, branch: br, hasReport: true},
		{name: "report and closed PR is still running", src: fakeSource{branches: map[string]time.Time{br: pushed, rep: pushed}, prs: map[string]PR{br: {Number: 7}}}, wantPhase: api.PhaseRunning, branch: br, hasReport: true},
		{name: "report and open PR is done, checks pending", src: fakeSource{branches: map[string]time.Time{br: pushed, rep: pushed}, prs: map[string]PR{br: {Number: 7, Open: true}}, checks: map[int]Checks{7: ChecksPending}}, wantPhase: api.PhaseDone, wantPR: 7, branch: br, hasReport: true},
		{name: "done with no checks", src: fakeSource{branches: map[string]time.Time{br: pushed, rep: pushed}, prs: map[string]PR{br: {Number: 7, Open: true}}, checks: map[int]Checks{7: ChecksNone}}, wantPhase: api.PhaseDone, wantPR: 7, branch: br, hasReport: true},
		{name: "done with green checks", src: fakeSource{branches: map[string]time.Time{br: pushed, rep: pushed}, prs: map[string]PR{br: {Number: 7, Open: true}}, checks: map[int]Checks{7: ChecksGreen}}, wantPhase: api.PhaseDone, wantPR: 7, branch: br, hasReport: true, green: ptr(true)},
		{name: "done with red checks", src: fakeSource{branches: map[string]time.Time{br: pushed, rep: pushed}, prs: map[string]PR{br: {Number: 7, Open: true}}, checks: map[int]Checks{7: ChecksRed}}, wantPhase: api.PhaseDone, wantPR: 7, branch: br, hasReport: true, green: ptr(false)},
		{name: "open PR without report is running", src: fakeSource{branches: map[string]time.Time{br: pushed}, prs: map[string]PR{br: {Number: 7, Open: true}}, checks: map[int]Checks{7: ChecksRed}}, wantPhase: api.PhaseRunning, wantPR: 7, branch: br, green: ptr(false)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			o := New(&tc.src)
			got, err := o.Observe(context.Background(), "42", 2)
			if err != nil {
				t.Fatal(err)
			}
			if got.Ticket != "42" || got.Attempt != 2 || got.Branch != tc.branch || got.PR != tc.wantPR || got.HasReport != tc.hasReport {
				t.Fatalf("got %+v", got)
			}
			if (got.ChecksGreen == nil) != (tc.green == nil) || (tc.green != nil && *got.ChecksGreen != *tc.green) {
				t.Fatalf("ChecksGreen = %v, want %v", got.ChecksGreen, tc.green)
			}
			if tc.branch != "" && !got.LastPush.Equal(pushed) {
				t.Fatalf("LastPush = %v", got.LastPush)
			}
			if p := PhaseOf(got); p != tc.wantPhase {
				t.Fatalf("phase = %s, want %s", p, tc.wantPhase)
			}
		})
	}
}

func TestObserveDiffFiles(t *testing.T) {
	br := "factory/9-a1"
	got, err := New(&fakeSource{branches: map[string]time.Time{br: pushed}, diff: map[string][]string{br: {"a.go", "b.go"}}}).Observe(context.Background(), "9", 1)
	if err != nil || len(got.DiffFiles) != 2 {
		t.Fatalf("got %+v err %v", got, err)
	}
}

func TestObserveSourceError(t *testing.T) {
	boom := errors.New("boom")
	if _, err := New(&fakeSource{err: boom}).Observe(context.Background(), "1", 1); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

func ptr(b bool) *bool { return &b }

var _ api.Observer = (*Observer)(nil)
