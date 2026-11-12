package broker_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/dispatch/broker"
	"github.com/KaaS-team/factory/internal/dispatch/broker/brokertest"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func TestGitHubClassify(t *testing.T) {
	c, err := broker.GitHub{TTL: time.Minute}.Open(context.Background(), brokertest.Source("x"))
	if err != nil {
		t.Fatal(err)
	}
	rows := []struct {
		method, target, verb, res string
		bad                       bool
	}{
		{"GET", "/repos/o/r/issues/3", "repo.read", "o/r", false},
		{"HEAD", "/repos/o/r", "repo.read", "o/r", false},
		{"POST", "/repos/o/r/pulls", "pr.create", "o/r", false},
		{"PATCH", "/repos/o/r/pulls/7", "pr.update", "o/r", false},
		{"POST", "/repos/o/r/issues/7/comments", "issue.comment", "o/r", false},
		{"PUT", "/repos/o/r/contents/a/b.md", "contents.write", "o/r", false},
		{"POST", "/repos/o/r/git/refs", "contents.write", "o/r", false},
		{"DELETE", "/repos/o/r", "", "", true},
		{"PUT", "/repos/o/r/pulls/7/merge", "", "", true},
		{"PATCH", "/repos/o/r/pulls/7/files", "", "", true},
		{"POST", "/user/repos", "", "", true},
		{"GET", "/orgs/x", "", "", true},
		{"GET", "/repos/o", "", "", true},
	}
	for _, r := range rows {
		a, err := c.Classify(r.method, r.target)
		if r.bad {
			if !errors.Is(err, broker.ErrUnclassified) {
				t.Errorf("%s %s: err %v, want ErrUnclassified", r.method, r.target, err)
			}
			continue
		}
		if err != nil || a.Verb != r.verb || a.Resource != r.res || a.Type != "github" {
			t.Errorf("%s %s: got %+v, %v", r.method, r.target, a, err)
		}
	}
}

func TestGateChecksClassifiedAction(t *testing.T) {
	policy := func(a broker.Action) error {
		if a.Verb == "repo.read" {
			return nil
		}
		return errors.New("denied")
	}
	b := broker.New(policy, brokertest.Adapter{Secret: "tok", TTL: time.Minute, Now: func() time.Time { return t0 }})
	cred, err := b.Request(context.Background(), "fake", "GET", "/repos/o/r")
	if err != nil || cred.Value != "tok" || !cred.ExpiresAt.Equal(t0.Add(time.Minute)) {
		t.Fatalf("read: %+v %v", cred, err)
	}
	if _, err := b.Request(context.Background(), "fake", "POST", "/repos/o/r/pulls"); !errors.Is(err, broker.ErrDenied) {
		t.Fatalf("write: err %v, want ErrDenied", err)
	}
	if _, err := b.Request(context.Background(), "fake", "DELETE", "/x"); !errors.Is(err, broker.ErrUnclassified) {
		t.Fatalf("unclassified: err %v", err)
	}
	if _, err := b.Request(context.Background(), "nope", "GET", "/x"); !errors.Is(err, broker.ErrNoAdapter) {
		t.Fatalf("adapter: err %v", err)
	}
}

func TestMintRefusesUnlistedAction(t *testing.T) {
	c, _ := broker.GitHub{TTL: time.Minute}.Open(context.Background(), brokertest.Source("x"))
	if _, err := c.Mint(context.Background(), broker.Action{Type: "github", Verb: "repo.delete", Resource: "o/r"}); !errors.Is(err, broker.ErrUnclassified) {
		t.Fatalf("err %v", err)
	}
}

func TestGitHubMintExpiry(t *testing.T) {
	c, _ := broker.GitHub{TTL: 90 * time.Second, Now: func() time.Time { return t0 }}.Open(context.Background(), brokertest.Source("tok"))
	cred, err := c.Mint(context.Background(), broker.Action{Type: "github", Verb: "repo.read", Resource: "o/r"})
	if err != nil || cred.Value != "tok" || cred.Type != "github" || !cred.ExpiresAt.Equal(t0.Add(90*time.Second)) {
		t.Fatalf("%+v %v", cred, err)
	}
}

func TestFileSource(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string, mode os.FileMode) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	rows := []struct {
		name, path, want string
		bad              bool
	}{
		{"ok", write("a", "tok\n", 0o600), "tok", false},
		{"open perms", write("b", "tok", 0o644), "", true},
		{"empty", write("c", " \n", 0o600), "", true},
		{"missing", filepath.Join(dir, "none"), "", true},
	}
	for _, r := range rows {
		got, err := broker.FileSource(r.path).Secret(context.Background())
		if (err != nil) != r.bad || got != r.want {
			t.Errorf("%s: %q, %v", r.name, got, err)
		}
	}
}

func TestSecretNeverInErrors(t *testing.T) {
	b := broker.New(func(broker.Action) error { return errors.New("no") }, brokertest.Adapter{Secret: "s3cret-value", TTL: time.Minute})
	_, err := b.Request(context.Background(), "fake", "GET", "/x")
	if err == nil || contains(err.Error(), "s3cret-value") {
		t.Fatalf("err %v", err)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
