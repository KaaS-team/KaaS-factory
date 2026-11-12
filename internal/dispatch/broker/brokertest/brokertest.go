// Package brokertest holds fakes for the broker package's tests.
package brokertest

import (
	"context"
	"time"

	"github.com/KaaS-team/factory/internal/dispatch/broker"
)

// Source is a fixed in-memory secret.
type Source string

// Secret returns the string.
func (s Source) Secret(context.Context) (string, error) { return string(s), nil }

// Adapter is a connector of type "fake": GET classifies as repo.read, POST as pr.create, the rest does not classify.
type Adapter struct {
	Secret string
	TTL    time.Duration
	Now    func() time.Time // defaults to time.Now
}

// Type returns "fake".
func (Adapter) Type() string { return "fake" }

// Classify maps GET and POST only.
func (Adapter) Classify(method, _ string) (broker.Action, error) {
	switch method {
	case "GET":
		return broker.Action{Type: "fake", Verb: "repo.read", Resource: "o/r"}, nil
	case "POST":
		return broker.Action{Type: "fake", Verb: "pr.create", Resource: "o/r"}, nil
	}
	return broker.Action{}, broker.ErrUnclassified
}

// Mint returns the secret expiring TTL from Now.
func (f Adapter) Mint(context.Context, broker.Action) (broker.Credential, error) {
	now := f.Now
	if now == nil {
		now = time.Now
	}
	return broker.Credential{Type: "fake", Value: f.Secret, ExpiresAt: now().Add(f.TTL)}, nil
}
