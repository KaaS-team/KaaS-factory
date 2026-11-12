package github_test

import (
	"context"
	"errors"
	"testing"
	"time"

	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

func TestSameLogin(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"Alice", "alice", true}, {"alice", "bob", false}, {"", "", false}, {"alice", "", false},
		{"dependabot[bot]", "Dependabot", true}, {"dependabot", "dependabot[bot]", true},
	}
	for _, c := range cases {
		if got := gh.SameLogin(c.a, c.b); got != c.want {
			t.Errorf("SameLogin(%q,%q)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestBotLogin(t *testing.T) {
	cases := []struct{ in, want string }{
		{"dependabot", "dependabot[bot]"}, {"dependabot[bot]", "dependabot[bot]"}, {"Renovate", "renovate[bot]"},
	}
	for _, c := range cases {
		if got := gh.BotLogin(c.in); got != c.want {
			t.Errorf("BotLogin(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

func TestEventFires(t *testing.T) {
	cfg := gh.TriggerConfig{Label: "factory:ready", Assignee: "@factory-bot"}
	cases := []struct {
		name string
		ev   gh.Event
		want bool
	}{
		{"comment by actor", gh.Event{Kind: gh.EvComment, Action: "created", Actor: "Dev", Author: "dev"}, true},
		{"comment edited by other", gh.Event{Kind: gh.EvComment, Action: "edited", Actor: "mod", Author: "dev"}, false},
		{"comment deleted", gh.Event{Kind: gh.EvComment, Action: "deleted", Actor: "dev", Author: "dev"}, false},
		{"comment with no author", gh.Event{Kind: gh.EvComment, Action: "created", Actor: "dev"}, false},
		{"review by other", gh.Event{Kind: gh.EvReview, Action: "submitted", Actor: "mod", Author: "dev"}, false},
		{"review by actor", gh.Event{Kind: gh.EvReview, Action: "submitted", Actor: "dev", Author: "dev"}, true},
		{"label matches case-insensitively", gh.Event{Kind: gh.EvIssue, Action: "labeled", Label: "Factory:Ready"}, true},
		{"label differs", gh.Event{Kind: gh.EvIssue, Action: "labeled", Label: "bug"}, false},
		{"unlabeled never fires", gh.Event{Kind: gh.EvIssue, Action: "unlabeled", Label: "factory:ready"}, false},
		{"assignee matches without at sign", gh.Event{Kind: gh.EvIssue, Action: "assigned", Assignee: "factory-bot"}, true},
		{"assignee differs", gh.Event{Kind: gh.EvIssue, Action: "assigned", Assignee: "someone"}, false},
		{"assignee is case-sensitive like upstream", gh.Event{Kind: gh.EvIssue, Action: "assigned", Assignee: "Factory-Bot"}, false},
		{"other issue action", gh.Event{Kind: gh.EvIssue, Action: "closed"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.ev.Fires(cfg); got != c.want {
				t.Fatalf("Fires=%v want %v", got, c.want)
			}
		})
	}
	// An unset trigger never matches: an empty label must not fire on an unnamed label.
	if (gh.Event{Kind: gh.EvIssue, Action: "labeled"}).Fires(gh.TriggerConfig{}) {
		t.Fatal("empty config fired")
	}
	if (gh.Event{Kind: gh.EvIssue, Action: "assigned"}).Fires(gh.TriggerConfig{}) {
		t.Fatal("empty assignee config fired")
	}
}

func TestAllowedBot(t *testing.T) {
	cases := []struct {
		actor, list string
		want        bool
	}{
		{"dependabot[bot]", "", false}, {"dependabot[bot]", "*", true}, {"dependabot[bot]", " Dependabot , x ", true},
		{"dependabot", "dependabot[bot]", true}, {"renovate[bot]", "dependabot", false}, {"x[bot]", " , ", false},
	}
	for _, c := range cases {
		if got := gh.AllowedBot(c.actor, c.list); got != c.want {
			t.Errorf("AllowedBot(%q,%q)=%v want %v", c.actor, c.list, got, c.want)
		}
	}
}

func TestCheckActor(t *testing.T) {
	kinds := map[string]string{"dev": "User", "app[bot]": "Bot", "org": "Organization"}
	kindOf := func(_ context.Context, l string) (string, error) {
		if k, ok := kinds[l]; ok {
			return k, nil
		}
		if l == "boom" {
			return "", errors.New("500")
		}
		return "", gh.ErrNoSuchUser
	}
	cases := []struct {
		name, actor, allowed string
		ok, err              bool
	}{
		{"human", "dev", "", true, false},
		{"bot refused", "app[bot]", "", false, false},
		{"bot allow-listed", "app[bot]", "app", true, false},
		{"bot allow all", "app[bot]", "*", true, false},
		{"organization refused", "org", "", false, false},
		{"unresolvable app refused", "Copilot", "", false, false},
		{"unresolvable app allow-listed", "Copilot", "copilot", true, false},
		{"lookup failure is an error and refuses", "boom", "*", false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ok, err := gh.CheckActor(context.Background(), kindOf, c.actor, c.allowed)
			if ok != c.ok || (err != nil) != c.err {
				t.Fatalf("ok=%v err=%v want ok=%v err=%v", ok, err, c.ok, c.err)
			}
		})
	}
}

// A bot that is not allow-listed is not trusted even with write access; an allow-listed one is.
func TestTrustRefusesNonHumanWriter(t *testing.T) {
	roleOf := roles(map[string]gh.Role{"dev": gh.RoleWrite, "app[bot]": gh.RoleWrite})
	kindOf := func(_ context.Context, l string) (string, error) {
		if l == "app[bot]" {
			return "Bot", nil
		}
		return "User", nil
	}
	now := func() time.Time { return time.Unix(0, 0) }
	deny := gh.NewTrust("runner", roleOf, now).WithActors(kindOf, "")
	if !deny.Trusted(context.Background(), "dev") || deny.Trusted(context.Background(), "app[bot]") {
		t.Fatal("human writer must pass and bot writer must not")
	}
	allow := gh.NewTrust("runner", roleOf, now).WithActors(kindOf, "app")
	if !allow.Trusted(context.Background(), "app[bot]") {
		t.Fatal("allow-listed bot writer must pass")
	}
	// The runner's own login matches case-insensitively.
	if !deny.Trusted(context.Background(), "RUNNER") {
		t.Fatal("self login is case-insensitive")
	}
}

// A comment whose recorded actor is someone other than its author is ignored.
func TestTrustCommandIgnoresEditedByOther(t *testing.T) {
	tr := gh.NewTrust("runner", roles(map[string]gh.Role{"dev": gh.RoleWrite}), func() time.Time { return time.Unix(0, 0) })
	if _, ok := tr.Command(context.Background(), gh.Comment{Author: "dev", Actor: "mod", Body: "/factory approve"}); ok {
		t.Fatal("edit by another actor was accepted")
	}
	if _, ok := tr.Command(context.Background(), gh.Comment{Author: "dev", Body: "/factory approve"}); !ok {
		t.Fatal("plain comment refused")
	}
}
