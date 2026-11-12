package depup

import (
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)

func aged(u Update, age time.Duration) Update { u.ReleasedAt = t0.Add(-age); return u }

func TestGateReady(t *testing.T) {
	g := Gate{MinAge: 72 * time.Hour}
	tests := []struct {
		name string
		u    Update
		ok   bool
	}{
		{"younger than gate", aged(lodash, 71*time.Hour), false},
		{"exactly the gate", aged(lodash, 72*time.Hour), true},
		{"older", aged(lodash, 100*time.Hour), true},
		{"unknown release date is held", lodash, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if ok, _ := g.Ready(tc.u, t0); ok != tc.ok {
				t.Errorf("got %v", ok)
			}
		})
	}
	if ok, _ := (Gate{}).Ready(lodash, t0); !ok {
		t.Error("zero gate must pass everything")
	}
}

func TestGateRoute(t *testing.T) {
	g := Gate{}
	for ty, want := range map[Type]Route{Major: ToAgent, Minor: Deterministic, Patch: Deterministic, "weird": ToAgent} {
		if got := g.Route(ty); got != want {
			t.Errorf("%s: got %s want %s", ty, got, want)
		}
	}
	g = Gate{Routing: map[Type]Route{Minor: ToAgent}}
	if g.Route(Minor) != ToAgent || g.Route(Patch) != Deterministic {
		t.Error("configured routing must override per type and keep defaults for the rest")
	}
}

// No session may be fired for an update younger than the gate.
func TestSplitFiresNothingForYoungUpdates(t *testing.T) {
	g := Gate{MinAge: 48 * time.Hour}
	ds := []Decision{
		{Update: aged(react, 100*time.Hour), Enabled: true},  // major, old: agent
		{Update: aged(lodash, 100*time.Hour), Enabled: true}, // minor, old: deterministic
		{Update: aged(react, time.Hour), Enabled: true},      // major, young: held
		{Update: aged(scoped, time.Hour), Enabled: true},     // patch, young: held
		{Update: lodash, SkipReason: SkipDisabled},           // already skipped: untouched
	}
	agent, det, held := g.Split(ds, t0)
	if len(agent) != 1 || agent[0].Package != "react" || len(det) != 1 || det[0].Package != "lodash" {
		t.Fatalf("agent=%v det=%v", agent, det)
	}
	if len(held) != 2 {
		t.Fatalf("held=%v", held)
	}
	for _, h := range held {
		if !strings.HasPrefix(h.SkipReason, SkipTooYoung) {
			t.Errorf("reason %q", h.SkipReason)
		}
	}
}

func TestStatus(t *testing.T) {
	g := Gate{MinAge: 72 * time.Hour}
	s := g.Status(aged(lodash, 24*time.Hour), t0)
	if s.Context != "depup/release-age" || s.State != "pending" || !strings.Contains(s.Description, "48h") {
		t.Errorf("pending: %+v", s)
	}
	s = g.Status(aged(lodash, 80*time.Hour), t0)
	if s.State != "success" {
		t.Errorf("success: %+v", s)
	}
}
