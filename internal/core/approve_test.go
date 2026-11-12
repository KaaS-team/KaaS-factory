package core

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/graph"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/observe"
	"github.com/KaaS-team/factory/internal/reconcile"
	"github.com/KaaS-team/factory/internal/store"
	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

// threadTracker is a tracker whose thread holds comments; Commands applies the real trust rule and
// the real chatops parser, so an untrusted author's words never become a command.
type threadTracker struct {
	listTracker
	trust    *gh.Trust
	comments []gh.Comment
	acked    map[int64]bool
}

func (t *threadTracker) Commands(ctx context.Context, _ api.TicketID) ([]observe.Command, error) {
	var out []observe.Command
	for _, c := range t.comments {
		cmd, ok := t.trust.Command(ctx, c)
		if !ok || t.acked[c.ID] {
			continue
		}
		switch cmd.Kind {
		case gh.CmdApprove:
			out = append(out, observe.Command{Verb: observe.VerbApprove, Ref: c.ID})
		case gh.CmdRevise:
			out = append(out, observe.Command{Verb: observe.VerbRevise, Ref: c.ID, Text: cmd.Text})
		}
	}
	return out, nil
}

func (t *threadTracker) Ack(_ context.Context, _ api.TicketID, ref int64) error {
	t.acked[ref] = true
	return nil
}

// briefDisp keeps the brief behind each session the fake dispatcher starts.
type briefDisp struct {
	*porttest.Dispatcher
	briefs map[string]api.Brief
}

func (d briefDisp) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	s, err := d.Dispatcher.Dispatch(ctx, b)
	if err == nil {
		d.briefs[s.Key] = b
	}
	return s, err
}

const planWorkflow = `steps:
  plan: { uses: plan, next: [{ park: awaiting-approval, approve: build, revise: plan }] }
  build: { uses: build }
`

// parkedRig runs ticket 5 through the plan node of a plan, approval, build workflow until it waits.
func parkedRig(t *testing.T) (*rig, *threadTracker, map[string]api.Brief) {
	t.Helper()
	g, err := graph.ParseYAML("w", []byte(planWorkflow))
	if err != nil {
		t.Fatal(err)
	}
	r := newRig(t, 2, meter.Budgets{}, tkt("5", 1))
	briefs := map[string]api.Brief{}
	tt := &threadTracker{listTracker: r.tr, acked: map[int64]bool{}, trust: gh.NewTrust("bot", func(_ context.Context, login string) (gh.Role, error) {
		if login == "maintainer" {
			return gh.RoleWrite, nil
		}
		return gh.RoleRead, nil
	}, func() time.Time { return t0 })}
	st, err := store.Open(filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	r.c, err = New(Deps{Tracker: tt, Dispatcher: briefDisp{r.disp, briefs}, Observer: r.obs, Store: st, Meter: r.m, Queue: r.mq, Clock: r.clk,
		Stages:  &Stages{Graph: func(string) (*graph.Graph, error) { return g, nil }},
		OnError: func(err error) { t.Errorf("loop error: %v", err) }},
		Config{Reconcile: reconcile.Config{Tick: 30 * time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	r.c.Tick(ctx)
	r.obs.Set(api.Observation{Ticket: "5", Attempt: 1, Branch: "factory/5-a1", HasReport: true, PR: 3, LastPush: t0})
	r.c.Tick(ctx)
	if got := r.tr.Phases["5"]; got != api.PhaseNeedsHuman {
		t.Fatalf("after the plan node the ticket is %q, want needs-human", got)
	}
	return r, tt, briefs
}

// The plan-approval commands act in the loop (factory /factory approve and revise), and only
// from a trusted author (Symphony 14: the thread is the state).
func TestApproveAndReviseThroughTick(t *testing.T) {
	cases := []struct {
		name, author, body string
		wantSession        string // the session dispatched after the command; "" means none
		wantText           string // text the new brief must carry
	}{
		{"approve moves to build", "maintainer", "/factory approve", "5-a2", ""},
		{"revise reruns plan with the text", "maintainer", "/factory revise split it in two", "5-a2", "split it in two"},
		{"untrusted approve changes nothing", "stranger", "/factory approve", "", ""},
		{"untrusted revise changes nothing", "stranger", "/factory revise do something else", "", ""},
		{"a plain comment changes nothing", "maintainer", "looks fine to me", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, tt, briefs := parkedRig(t)
			before := len(r.disp.Sessions)
			tt.comments = append(tt.comments, gh.Comment{ID: 1, Author: c.author, Body: c.body})
			r.c.Tick(context.Background())
			if c.wantSession == "" {
				if len(r.disp.Sessions) != before || r.tr.Phases["5"] != api.PhaseNeedsHuman {
					t.Fatalf("sessions %v, phase %q: want the ticket still parked", r.disp.Sessions, r.tr.Phases["5"])
				}
				return
			}
			if _, ok := r.disp.Sessions[c.wantSession]; !ok {
				t.Fatalf("sessions %v, want %s", r.disp.Sessions, c.wantSession)
			}
			if !tt.acked[1] {
				t.Fatal("the command was not acknowledged")
			}
			if c.wantText != "" && !strings.Contains(briefs[c.wantSession].Text, c.wantText) {
				t.Fatalf("brief %q does not carry %q", briefs[c.wantSession].Text, c.wantText)
			}
			if c.wantText == "" && strings.Contains(briefs[c.wantSession].Text, "Revision") {
				t.Fatalf("an approve carried revision text: %q", briefs[c.wantSession].Text)
			}
			wantNode := map[bool]string{true: "plan", false: "build"}[c.wantText != ""]
			if got := briefs[c.wantSession].Node; got != wantNode {
				t.Fatalf("node %q, want %q", got, wantNode)
			}
		})
	}
}

// A command on a ticket that is not waiting is acknowledged and does nothing else.
func TestApproveWithoutWaitingTicketIsIgnored(t *testing.T) {
	r, tt, _ := parkedRig(t)
	tt.comments = append(tt.comments, gh.Comment{ID: 1, Author: "maintainer", Body: "/factory approve"})
	r.c.Tick(context.Background()) // approves
	before := len(r.disp.Sessions)
	tt.comments = append(tt.comments, gh.Comment{ID: 2, Author: "maintainer", Body: "/factory approve"})
	var errs []error
	r.c.d.OnError = func(err error) { errs = append(errs, err) }
	r.c.Tick(context.Background())
	if len(r.disp.Sessions) != before || len(errs) != 1 || !strings.Contains(fmt.Sprint(errs[0]), "not waiting") {
		t.Fatalf("sessions %d->%d, errors %v", before, len(r.disp.Sessions), errs)
	}
}
