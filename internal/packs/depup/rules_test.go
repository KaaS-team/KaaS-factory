package depup

import (
	"strings"
	"testing"
)

func bp(b bool) *bool { return &b }

var (
	lodash = Update{Package: "lodash", File: "package.json", Current: "4.0.0", New: "4.1.0", Type: Minor}
	react  = Update{Package: "react", File: "package.json", Current: "17.0.0", New: "18.0.0", Type: Major}
	scoped = Update{Package: "@types/node", File: "web/package.json", Current: "20.1.0", New: "20.1.1", Type: Patch}
)

// Symphony 8.2 candidate selection: an update is a candidate once, in order, with a recorded reason when it is not.
func TestEvaluate(t *testing.T) {
	tests := []struct {
		name     string
		rules    []Rule
		ups      []Update
		inflight map[string]bool
		want     []Decision
	}{
		{"no rules enables", nil, []Update{lodash}, nil, []Decision{{Update: lodash, Enabled: true}}},
		{"disabled rule records reason", []Rule{{Match: Match{Packages: []string{"lodash"}}, Enabled: bp(false)}},
			[]Update{lodash}, nil, []Decision{{Update: lodash, SkipReason: SkipDisabled}}},
		{"last match wins", []Rule{
			{Match: Match{Packages: []string{"*"}}, Enabled: bp(false)},
			{Match: Match{Types: []Type{Major}}, Enabled: bp(true)},
		}, []Update{react, lodash}, nil, []Decision{
			{Update: react, Enabled: true},
			{Update: lodash, SkipReason: SkipDisabled},
		}},
		{"scoped glob and file glob", []Rule{{Match: Match{Packages: []string{"@types/*"}, Files: []string{"web/*"}}, GroupName: "types", Automerge: bp(true)}},
			[]Update{scoped, lodash}, nil, []Decision{
				{Update: scoped, Enabled: true, Automerge: true, Group: "types"},
				{Update: lodash, Enabled: true},
			}},
		{"non matching type", []Rule{{Match: Match{Types: []Type{Patch}}, Enabled: bp(false)}}, []Update{lodash}, nil,
			[]Decision{{Update: lodash, Enabled: true}}},
		{"collision with in flight", nil, []Update{lodash}, map[string]bool{"package.json:lodash:4.0.0": true},
			[]Decision{{Update: lodash, SkipReason: SkipCollision}}},
		{"duplicate in batch", nil, []Update{lodash, lodash}, nil,
			[]Decision{{Update: lodash, Enabled: true}, {Update: lodash, SkipReason: SkipCollision}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(tc.rules, tc.ups, tc.inflight)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d decisions, want %d", len(got), len(tc.want))
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("decision %d: got %+v want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestTicketsGroupYieldsOneTicket(t *testing.T) {
	other := Update{Package: "eslint", File: "package.json", Current: "8.0.0", New: "8.1.0", Type: Minor}
	ds := Evaluate([]Rule{{Match: Match{Types: []Type{Minor, Patch}}, GroupName: "safe", Automerge: bp(true)}},
		[]Update{lodash, scoped, other, react}, nil)
	ts := Tickets(ds, "acme/app")
	if len(ts) != 2 {
		t.Fatalf("want 2 tickets (1 group + 1 single), got %d", len(ts))
	}
	g := ts[0]
	if !strings.Contains(g.Title, "safe") || len(g.Files) != 2 || g.Repo != "acme/app" {
		t.Errorf("group ticket wrong: %+v", g)
	}
	for _, p := range []string{"lodash", "@types/node", "eslint"} {
		if !strings.Contains(g.Body, p) {
			t.Errorf("group body misses %s", p)
		}
	}
	if !contains(g.Labels, "automerge") || !contains(g.Labels, Label) {
		t.Errorf("labels: %v", g.Labels)
	}
	if contains(ts[1].Labels, "automerge") || len(ts[1].Files) != 1 {
		t.Errorf("single ticket wrong: %+v", ts[1])
	}
}

func TestTicketsSkipsSkipped(t *testing.T) {
	ds := Evaluate(nil, []Update{lodash}, map[string]bool{lodash.Key(): true})
	if got := Tickets(ds, "r"); len(got) != 0 {
		t.Errorf("skipped decision produced %d tickets", len(got))
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
