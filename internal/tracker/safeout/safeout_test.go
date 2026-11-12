package safeout

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeW struct {
	comments []string
	labels   [][]string
	issues   []string
	fail     bool
}

func (f *fakeW) Comment(_ context.Context, _ string, b string) error {
	if f.fail {
		return errors.New("boom")
	}
	f.comments = append(f.comments, b)
	return nil
}
func (f *fakeW) AddLabels(_ context.Context, _ string, l []string) error {
	f.labels = append(f.labels, l)
	return nil
}
func (f *fakeW) CreateIssue(_ context.Context, t, b string, _ []string) (string, error) {
	f.issues = append(f.issues, t+"|"+b)
	return "1", nil
}

type fakeL struct{ rs []Result }

func (f *fakeL) Record(_ context.Context, r Result) error { f.rs = append(f.rs, r); return nil }

var now = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func run(t *testing.T, in string, p Policy, w *fakeW) ([]Result, *fakeL) {
	t.Helper()
	items, bad, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	l := &fakeL{}
	res, err := Apply(context.Background(), "7", items, bad, p, w, l, now, nil)
	if err != nil {
		t.Fatal(err)
	}
	return res, l
}

func TestInvalidLinesDroppedWithLineNumberValidStillApplied(t *testing.T) {
	w := &fakeW{}
	in := `{"type":"comment","body":"one"}
not json

{"body":"no type"}
{"type":"comment","body":"two"}
{"type":"nuke","body":"x"}
`
	res, _ := run(t, in, Policy{"comment": {Max: -1}}, w)
	if len(w.comments) != 2 {
		t.Fatalf("applied %v", w.comments)
	}
	got := map[int]string{}
	for _, r := range res {
		got[r.Line] = r.Outcome
	}
	want := map[int]string{1: Applied, 2: Dropped, 4: Dropped, 5: Applied, 6: Dropped}
	for l, o := range want {
		if got[l] != o {
			t.Errorf("line %d: got %q want %q", l, got[l], o)
		}
	}
}

func TestPolicyRows(t *testing.T) {
	cases := []struct {
		name, in string
		p        Policy
		outcome  string
		reason   string
	}{
		{"max reached", `{"type":"comment","body":"a"}` + "\n" + `{"type":"comment","body":"b"}`, Policy{"comment": {Max: 1}}, Dropped, "over max 1"},
		{"label not allowed", `{"type":"add_labels","labels":["evil"]}`, Policy{"add_labels": {Max: 1, Labels: []string{"ok"}}}, Dropped, "label not allowed"},
		{"label allowed", `{"type":"add_labels","labels":["ok"]}`, Policy{"add_labels": {Max: 1, Labels: []string{"ok"}}}, Applied, ""},
		{"title prefix missing", `{"type":"create_issue","title":"x"}`, Policy{"create_issue": {Max: 1, TitlePrefix: "[bot] "}}, Dropped, "lacks prefix"},
		{"title prefix ok", `{"type":"create_issue","title":"[bot] x"}`, Policy{"create_issue": {Max: 1, TitlePrefix: "[bot] "}}, Applied, ""},
		{"staged", `{"type":"comment","body":"a"}`, Policy{"comment": {Max: 1, Staged: true}}, Staged, ""},
		{"verb absent", `{"type":"comment","body":"a"}`, Policy{}, Dropped, "not allowed"},
		{"empty body", `{"type":"comment","body":" "}`, Policy{"comment": {Max: 1}}, Dropped, "empty body"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := &fakeW{}
			res, _ := run(t, c.in, c.p, w)
			last := res[len(res)-1]
			if last.Outcome != c.outcome || !strings.Contains(last.Reason, c.reason) {
				t.Fatalf("got %+v", last)
			}
			if c.outcome == Staged && (len(w.comments) != 0) {
				t.Fatal("staged wrote")
			}
		})
	}
}

func TestExpiresStampsCreatedIssue(t *testing.T) {
	w := &fakeW{}
	run(t, `{"type":"create_issue","title":"t","body":"b"}`, Policy{"create_issue": {Max: 1, Expires: 48 * time.Hour}}, w)
	if !strings.Contains(w.issues[0], "<!-- factory:expires 2026-01-03T00:00:00Z -->") {
		t.Fatal(w.issues)
	}
}

func TestMaxRule(t *testing.T) {
	for n, ok := range map[int]bool{-1: true, 1: true, 5: true, 0: false, -2: false} {
		if ValidMax(n) != ok {
			t.Errorf("ValidMax(%d)", n)
		}
	}
	if (Policy{"comment": {Max: 0}}).Validate() == nil {
		t.Fatal("max 0 accepted")
	}
}

func TestLedgerRecordsEveryItemAndOutcome(t *testing.T) {
	w := &fakeW{}
	_, l := run(t, `{"type":"comment","body":"a"}`+"\nbad\n", Policy{"comment": {Max: 1}}, w)
	if len(l.rs) != 2 {
		t.Fatalf("ledger %+v", l.rs)
	}
}

func TestWriteFailureIsReportedNotFatal(t *testing.T) {
	w := &fakeW{fail: true}
	res, _ := run(t, `{"type":"comment","body":"a"}`, Policy{"comment": {Max: 1}}, w)
	if res[0].Outcome != Dropped {
		t.Fatal(res)
	}
}

func TestNoTrackerTokenInAgentEnv(t *testing.T) {
	env := []string{"PATH=/bin", "GITHUB_TOKEN=x", "GH_TOKEN=y", "LINEAR_API_KEY=z", "JIRA_API_TOKEN=q", "HOME=/h"}
	for _, kv := range AgentEnv(env) {
		if strings.Contains(kv, "TOKEN") || strings.Contains(kv, "API_KEY") {
			t.Fatalf("leaked %s", kv)
		}
	}
	if len(AgentEnv(env)) != 2 {
		t.Fatal(AgentEnv(env))
	}
}
