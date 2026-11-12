//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package policy_test

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/ee/policy"
	"github.com/KaaS-team/factory/internal/api"
)

type fakeControl struct {
	api.Control
	calls []string
}

func (f *fakeControl) Board(context.Context) (api.Board, error) {
	return api.Board{Ready: []api.Ticket{{ID: "1", Repo: "acme/api"}, {ID: "2", Repo: "other/api"}}}, nil
}
func (f *fakeControl) Dispatch(_ context.Context, id api.TicketID) error {
	f.calls = append(f.calls, "dispatch "+string(id))
	return nil
}
func (f *fakeControl) Retry(_ context.Context, id api.TicketID) error {
	f.calls = append(f.calls, "retry "+string(id))
	return nil
}

func TestGuardChecksBeforeActing(t *testing.T) {
	e, err := policy.Parse([]byte(rules))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, role, ticket string
		call               string
		allow              bool
		rule               string
	}{
		{"dispatch allowed", "operator", "1", "dispatch", true, "allow-operator-dispatch"},
		{"retry allowed", "operator", "1", "retry", true, "allow-operator-dispatch"},
		{"repo outside rule", "operator", "2", "dispatch", false, policy.RuleDefaultDeny},
		{"missing rule denies", "viewer", "1", "retry", false, policy.RuleDefaultDeny},
		{"unknown ticket has no repo", "operator", "9", "dispatch", false, policy.RuleDefaultDeny},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeControl{}
			var audit bytes.Buffer
			g := policy.Guard(f, e, policy.Actor{ID: "bot", Role: c.role}, &audit)
			if c.call == "dispatch" {
				err = g.Dispatch(context.Background(), api.TicketID(c.ticket))
			} else {
				err = g.Retry(context.Background(), api.TicketID(c.ticket))
			}
			if (err == nil) != c.allow || (len(f.calls) == 1) != c.allow {
				t.Fatalf("err=%v calls=%v, want allow=%v", err, f.calls, c.allow)
			}
			if n := strings.Count(audit.String(), "\n"); n != 1 {
				t.Fatalf("%d audit lines, want 1: %q", n, audit.String())
			}
			if !strings.Contains(audit.String(), `"rule":"`+c.rule+`"`) {
				t.Fatalf("audit %q lacks rule %s", audit.String(), c.rule)
			}
		})
	}
}
