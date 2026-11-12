package github_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

func roles(m map[string]gh.Role) func(context.Context, string) (gh.Role, error) {
	return func(_ context.Context, login string) (gh.Role, error) {
		r, ok := m[login]
		if !ok {
			return "", errors.New("lookup failed")
		}
		return r, nil
	}
}

func TestParseChatOps(t *testing.T) {
	cases := []struct {
		name string
		body string
		want gh.Command
	}{
		{"approve", "/factory approve", gh.Command{Kind: gh.CmdApprove}},
		{"approve with trailing words", "/factory approve thanks", gh.Command{Kind: gh.CmdApprove}},
		{"revise with text", "/factory revise use a map\nnot a slice", gh.Command{Kind: gh.CmdRevise, Text: "use a map\nnot a slice"}},
		{"revise empty", "/factory revise", gh.Command{Kind: gh.CmdRevise}},
		{"retry", "/factory retry", gh.Command{Kind: gh.CmdRetry}},
		{"retry force", "/factory retry --force", gh.Command{Kind: gh.CmdRetry, Force: true}},
		{"retry step", "/factory retry Verify", gh.Command{Kind: gh.CmdRetry, Step: "verify"}},
		{"retry force step", "/factory retry --force build", gh.Command{Kind: gh.CmdRetry, Force: true, Step: "build"}},
		{"cancel", "/factory cancel", gh.Command{Kind: gh.CmdCancel}},
		{"upper case verb", "/FACTORY APPROVE", gh.Command{Kind: gh.CmdApprove}},
		{"leading space", "  \n/factory cancel", gh.Command{Kind: gh.CmdCancel}},
		{"signature stripped from revise", "/factory revise tighten it\n\n<sub>Sent from the factory control plane by alice</sub>", gh.Command{Kind: gh.CmdRevise, Text: "tighten it"}},
		{"verb is a prefix of a word", "/factory approvex", gh.Command{Kind: gh.CmdAnswer, Text: "/factory approvex"}},
		{"unknown verb is an answer", "/factory dance", gh.Command{Kind: gh.CmdAnswer, Text: "/factory dance"}},
		{"command not first is an answer", "please /factory approve", gh.Command{Kind: gh.CmdAnswer, Text: "please /factory approve"}},
		{"plain answer", "  use option B  ", gh.Command{Kind: gh.CmdAnswer, Text: "use option B"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := gh.ParseChatOps(tc.body); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestSignedByRoundTrip(t *testing.T) {
	signed := gh.SignedBy("/factory approve", "bob")
	if signed != "/factory approve\n\n<sub>Sent from the factory control plane by bob</sub>" {
		t.Fatalf("SignedBy = %q", signed)
	}
	if got := gh.Unsigned(signed); got != "/factory approve" {
		t.Fatalf("Unsigned = %q", got)
	}
	if got := gh.SignedBy("", "bob"); got != "<sub>Sent from the factory control plane by bob</sub>" {
		t.Fatalf("SignedBy empty = %q", got)
	}
}

// The trust rule (src/trust.ts): write access or higher, or the runner itself. Anyone else is ignored.
func TestTrustCommand(t *testing.T) {
	roleOf := roles(map[string]gh.Role{
		"owner": gh.RoleAdmin, "maint": gh.RoleMaintain, "dev": gh.RoleWrite,
		"triager": gh.RoleTriage, "reader": gh.RoleRead, "rando": gh.RoleNone,
	})
	for _, verb := range []string{"approve", "revise fix it", "retry", "cancel"} {
		body := "/factory " + verb
		cases := []struct {
			author string
			ok     bool
		}{
			{"owner", true}, {"maint", true}, {"dev", true}, {"runner-bot", true},
			{"triager", false}, {"reader", false}, {"rando", false},
			{"unknown-lookup-fails", false},
		}
		for _, tc := range cases {
			t.Run(verb+"/"+tc.author, func(t *testing.T) {
				tr := gh.NewTrust("runner-bot", roleOf, time.Now)
				_, ok := tr.Command(context.Background(), gh.Comment{Author: tc.author, Body: body})
				if ok != tc.ok {
					t.Fatalf("ok = %v, want %v", ok, tc.ok)
				}
			})
		}
	}
}

func TestTrustCommandKinds(t *testing.T) {
	tr := gh.NewTrust("bot", roles(map[string]gh.Role{"dev": gh.RoleWrite}), time.Now)
	want := map[string]gh.CommandKind{
		"/factory approve": gh.CmdApprove, "/factory revise x": gh.CmdRevise,
		"/factory retry": gh.CmdRetry, "/factory cancel": gh.CmdCancel,
	}
	for body, kind := range want {
		cmd, ok := tr.Command(context.Background(), gh.Comment{Author: "dev", Body: body})
		if !ok || cmd.Kind != kind {
			t.Errorf("%q -> %+v, %v; want kind %s", body, cmd, ok, kind)
		}
	}
}

func TestTrustIgnoresRunnerMarkers(t *testing.T) {
	// A comment carrying a factory marker is the runner's own artifact, never a human command.
	tr := gh.NewTrust("bot", roles(map[string]gh.Role{"dev": gh.RoleWrite}), time.Now)
	_, ok := tr.Command(context.Background(), gh.Comment{Author: "dev", Body: "/factory approve\n<!-- factory:data {\"stage\":\"plan\"} -->"})
	if ok {
		t.Fatal("a body with a factory marker was taken as a command")
	}
}

func TestTrustCachesRoles(t *testing.T) {
	calls := 0
	now := time.Unix(1000, 0)
	roleOf := func(context.Context, string) (gh.Role, error) { calls++; return gh.RoleWrite, nil }
	tr := gh.NewTrust("bot", roleOf, func() time.Time { return now })
	c := gh.Comment{Author: "dev", Body: "/factory approve"}
	for i := 0; i < 3; i++ {
		tr.Command(context.Background(), c)
	}
	if calls != 1 {
		t.Fatalf("role lookups = %d within the TTL, want 1", calls)
	}
	now = now.Add(gh.RoleCacheTTL + time.Second)
	tr.Command(context.Background(), c)
	if calls != 2 {
		t.Fatalf("role lookups = %d after the TTL, want 2", calls)
	}
}

func TestTrustedOnlyFiltersThread(t *testing.T) {
	tr := gh.NewTrust("bot", roles(map[string]gh.Role{"dev": gh.RoleWrite, "reader": gh.RoleRead}), time.Now)
	in := []gh.Comment{{ID: 1, Author: "reader"}, {ID: 2, Author: "dev"}, {ID: 3, Author: "bot"}, {ID: 4, Author: "ghost"}}
	var ids []int64
	for _, c := range tr.TrustedOnly(context.Background(), in) {
		ids = append(ids, c.ID)
	}
	if !reflect.DeepEqual(ids, []int64{2, 3}) {
		t.Fatalf("kept %v, want [2 3]", ids)
	}
}
