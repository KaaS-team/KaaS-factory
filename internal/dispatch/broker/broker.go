// Package broker lets a sandboxed session ask for a short-lived upstream credential per action,
// so the session never holds the long-lived secret. The gate sees the classified action before
// anything is minted.
package broker

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Errors returned by Broker.Request and Connector methods.
var (
	ErrUnclassified = errors.New("broker: action is not classified")
	ErrDenied       = errors.New("broker: gate denied the action")
	ErrNoAdapter    = errors.New("broker: no adapter for type")
)

// Action is what a request means upstream: a verb the gate can allow or deny, on a resource.
type Action struct {
	Type     string // adapter type, for example "github"
	Verb     string // for example "pr.create"
	Resource string // for example "owner/repo"
}

// Credential is a secret that stops working at ExpiresAt.
type Credential struct {
	Type      string
	Value     string
	ExpiresAt time.Time
}

// Source yields the long-lived upstream secret. Only the broker process reads it.
type Source interface {
	Secret(ctx context.Context) (string, error)
}

// Adapter describes one upstream service and opens a Connector over its secret.
type Adapter interface {
	Type() string
	Actions() []string
	Open(ctx context.Context, src Source) (Connector, error)
}

// Connector classifies requests to one upstream and mints credentials for classified actions.
type Connector interface {
	Type() string
	Classify(method, target string) (Action, error)
	Mint(ctx context.Context, a Action) (Credential, error)
}

// Policy returns nil to allow a classified action. The factory wires its CEL gate here.
type Policy func(Action) error

// Broker routes a request to a connector, asks the policy, then mints.
type Broker struct {
	policy Policy
	conns  map[string]Connector
}

// New returns a Broker over the given connectors, keyed by Type.
func New(policy Policy, conns ...Connector) *Broker {
	m := make(map[string]Connector, len(conns))
	for _, c := range conns {
		m[c.Type()] = c
	}
	return &Broker{policy: policy, conns: m}
}

// Request classifies method and target with the connector for typ, checks the policy and mints.
// Error text never carries the secret.
func (b *Broker) Request(ctx context.Context, typ, method, target string) (Credential, error) {
	c, ok := b.conns[typ]
	if !ok {
		return Credential{}, fmt.Errorf("%w %q", ErrNoAdapter, typ)
	}
	a, err := c.Classify(method, target)
	if err != nil {
		return Credential{}, err
	}
	if err := b.policy(a); err != nil {
		return Credential{}, fmt.Errorf("%w: %s %s on %s: %w", ErrDenied, a.Type, a.Verb, a.Resource, err)
	}
	return c.Mint(ctx, a)
}
