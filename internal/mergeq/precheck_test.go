package mergeq

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type fakeApplier map[string][]string // head -> stale paths

func (f fakeApplier) Stale(_ context.Context, _, head string) ([]string, error) {
	if head == "boom" {
		return nil, errors.New("git failed")
	}
	return f[head], nil
}

type fakeSyntax map[string]string // head -> bad path

func (f fakeSyntax) Invalid(_ context.Context, head string, _ []string) (string, string, error) {
	if p := f[head]; p != "" {
		return p, "unexpected }", nil
	}
	return "", "", nil
}

func TestPrecheckFilter(t *testing.T) {
	paths := func(context.Context, string, string) ([]string, error) { return []string{"a.go"}, nil }
	es := []Entry{{ID: "1", Head: "h1"}, {ID: "2", Head: "h2"}, {ID: "3", Head: "h3"}}
	tests := []struct {
		name    string
		p       *Precheck
		es      []Entry
		wantOK  []string
		wantBad []Failure
		wantErr bool
	}{
		{"all apply, no syntax", &Precheck{Applier: fakeApplier{}}, es, []string{"1", "2", "3"}, nil, false},
		{"stale names the failing path", &Precheck{Applier: fakeApplier{"h2": {"x/y.go", "z.go"}}}, es, []string{"1", "3"},
			[]Failure{{ID: "2", Path: "x/y.go", Reason: "does not apply onto the current base; conflicts in x/y.go, z.go"}}, false},
		{"syntax failure when grammars are present", &Precheck{Applier: fakeApplier{}, Syntax: fakeSyntax{"h3": "a.go"}, Paths: paths}, es, []string{"1", "2"},
			[]Failure{{ID: "3", Path: "a.go", Reason: "syntax error: unexpected }"}}, false},
		{"syntax skipped when nil", &Precheck{Applier: fakeApplier{}, Paths: paths}, es, []string{"1", "2", "3"}, nil, false},
		{"stale is reported before syntax", &Precheck{Applier: fakeApplier{"h1": {"s.go"}}, Syntax: fakeSyntax{"h1": "a.go"}, Paths: paths}, es[:1], nil,
			[]Failure{{ID: "1", Path: "s.go", Reason: "does not apply onto the current base; conflicts in s.go"}}, false},
		{"applier error", &Precheck{Applier: fakeApplier{}}, []Entry{{ID: "9", Head: "boom"}}, nil, nil, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ok, bad, err := tc.p.Filter(context.Background(), "B", tc.es)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v", err)
			}
			var ids []string
			for _, e := range ok {
				ids = append(ids, e.ID)
			}
			if !reflect.DeepEqual(ids, tc.wantOK) {
				t.Errorf("ok = %v, want %v", ids, tc.wantOK)
			}
			if !reflect.DeepEqual(bad, tc.wantBad) {
				t.Errorf("bad = %+v, want %+v", bad, tc.wantBad)
			}
		})
	}
}

// A PR that fails the precheck is returned to its agent and never reaches the gate or the queue ejection.
func TestRunReturnsStalePRToAgent(t *testing.T) {
	w := newWorld(2)
	var returned []Failure
	r := &Runner{Git: w, Gate: w, Store: w, Cfg: Config{BatchSize: 4}, Pre: &Precheck{
		Applier: fakeApplier{"h1": {"stale.go"}},
		Return:  func(_ context.Context, f Failure) error { returned = append(returned, f); w.remove(f.ID); return nil },
	}}
	rep, err := r.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(returned) != 1 || returned[0].ID != "1" || returned[0].Path != "stale.go" {
		t.Fatalf("returned = %+v", returned)
	}
	if !reflect.DeepEqual(rep.Landed, []string{"2"}) || len(rep.Ejected) != 0 {
		t.Errorf("landed %v ejected %v, want only PR 2 landed", rep.Landed, rep.Ejected)
	}
	if !reflect.DeepEqual(rep.Returned, []string{"1"}) {
		t.Errorf("returned report = %v", rep.Returned)
	}
}

// Symphony §7: a returned ticket goes back to the running claim state with the failing path in a comment.
func TestCoreQueueReturnsStaleTicketToRunning(t *testing.T) {
	g := newRig(t, 2)
	q := g.queue()
	q.d.Applier = fakeApplier{} // filled below once heads are known
	g.enqueue(t, q, 1, 2)
	h1 := g.r.git(g.r.origin, "rev-parse", "refs/heads/pr/1")
	q.d.Applier = fakeApplier{h1: {"f1"}}
	rep, err := q.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rep.Returned, []string{"T1"}) || !reflect.DeepEqual(rep.Landed, []string{"T2"}) {
		t.Fatalf("returned %v landed %v", rep.Returned, rep.Landed)
	}
	if p := g.k.Phases["T1"]; p != "running" {
		t.Errorf("T1 phase %s, want running", p)
	}
	last := g.k.Comments_("T1")
	if c := last[len(last)-1]; !strings.Contains(c, "`f1`") {
		t.Errorf("comment %q does not name the failing path", c)
	}
}
