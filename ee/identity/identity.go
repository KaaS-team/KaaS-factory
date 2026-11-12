//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

// Package identity mints per-run agent tokens that say who an agent is and nothing about what it
// may do. Authority is asked of a live Gate on every side effect, and a revoked token stops
// working on the next one.
package identity

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Kind says what sort of principal is acting.
type Kind string

// The principal kinds. Only KindHuman and KindOperator may mint or revoke.
const (
	KindHuman    Kind = "human"
	KindOperator Kind = "operator"
	KindAgent    Kind = "agent"
)

// Principal is who is calling Mint or Revoke.
type Principal struct {
	ID   string
	Kind Kind
}

// Claims is the whole content of a token: identity, no scopes.
type Claims struct {
	ID        string    `json:"jti"`
	AgentID   string    `json:"agent"`
	RunID     string    `json:"run"`
	Tenant    string    `json:"tenant"`
	Delegator string    `json:"delegator"`
	Expires   time.Time `json:"-"`
}

// wire is the signed payload; exp is Unix seconds.
type wire struct {
	Claims
	Exp int64 `json:"exp"`
}

// EventType names a ledger event this package writes.
type EventType string

// The ledger events.
const (
	EventMint   EventType = "identity.mint"
	EventRevoke EventType = "identity.revoke"
)

// Event is one ledger entry: who did it, to which token and agent run.
type Event struct {
	Type      EventType
	Principal string
	TokenID   string
	AgentID   string
	RunID     string
	Tenant    string
	Reason    string
	At        time.Time
}

// Ledger records identity events. Append must fail if the event was not recorded.
type Ledger interface {
	Append(ctx context.Context, e Event) error
}

// Gate decides live whether the identity in claims may take action. It is the only source of
// authority.
type Gate interface {
	Allow(ctx context.Context, c Claims, action string) error
}

// ErrRevoked is returned for a token on the blocklist.
var ErrRevoked = errors.New("identity: token revoked")

// Issuer mints, verifies and revokes tokens. It is safe for concurrent use.
type Issuer struct {
	key    []byte
	ledger Ledger
	ttl    time.Duration
	now    func() time.Time

	mu      sync.Mutex
	blocked map[string]time.Time // token id -> when the entry may be dropped
}

// NewIssuer returns an Issuer signing with key (at least 32 bytes). Tokens last ttl. now is the clock.
func NewIssuer(key []byte, l Ledger, ttl time.Duration, now func() time.Time) (*Issuer, error) {
	if len(key) < 32 {
		return nil, errors.New("identity: key must be at least 32 bytes")
	}
	return &Issuer{key: key, ledger: l, ttl: ttl, now: now, blocked: map[string]time.Time{}}, nil
}

func canAct(p Principal) error {
	if p.ID == "" || (p.Kind != KindHuman && p.Kind != KindOperator) {
		return fmt.Errorf("identity: only a human or operator may do this, not %q", p.Kind)
	}
	return nil
}

// Mint returns a token for one agent run, delegated by who. It records an EventMint first and
// fails if that cannot be written.
func (is *Issuer) Mint(ctx context.Context, who Principal, agentID, runID, tenant string) (string, error) {
	if err := canAct(who); err != nil {
		return "", err
	}
	if agentID == "" || runID == "" || tenant == "" {
		return "", errors.New("identity: agent, run and tenant are required")
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	now := is.now()
	w := wire{Claims: Claims{ID: hex.EncodeToString(b[:]), AgentID: agentID, RunID: runID, Tenant: tenant, Delegator: who.ID}, Exp: now.Add(is.ttl).Unix()}
	if err := is.ledger.Append(ctx, Event{Type: EventMint, Principal: who.ID, TokenID: w.ID, AgentID: agentID, RunID: runID, Tenant: tenant, At: now}); err != nil {
		return "", fmt.Errorf("identity: ledger: %w", err)
	}
	payload, _ := json.Marshal(w)
	p := base64.RawURLEncoding.EncodeToString(payload)
	return p + "." + is.sign(p), nil
}

func (is *Issuer) sign(p string) string {
	m := hmac.New(sha256.New, is.key)
	m.Write([]byte(p))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// Verify checks signature and expiry and returns the claims. It does not look at the blocklist;
// Authorize does.
func (is *Issuer) Verify(tok string) (Claims, error) {
	p, sig, ok := strings.Cut(tok, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(is.sign(p))) {
		return Claims{}, errors.New("identity: bad token")
	}
	raw, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return Claims{}, errors.New("identity: bad token")
	}
	var w wire
	if err := json.Unmarshal(raw, &w); err != nil {
		return Claims{}, errors.New("identity: bad token")
	}
	w.Expires = time.Unix(w.Exp, 0)
	if !is.now().Before(w.Expires) {
		return Claims{}, errors.New("identity: token expired")
	}
	return w.Claims, nil
}

// Revoke puts a token id on the blocklist until any token could have expired and records an
// EventRevoke first. It fails if that cannot be written.
func (is *Issuer) Revoke(ctx context.Context, who Principal, tokenID, reason string) error {
	if err := canAct(who); err != nil {
		return err
	}
	now := is.now()
	if err := is.ledger.Append(ctx, Event{Type: EventRevoke, Principal: who.ID, TokenID: tokenID, Reason: reason, At: now}); err != nil {
		return fmt.Errorf("identity: ledger: %w", err)
	}
	is.mu.Lock()
	defer is.mu.Unlock()
	is.blocked[tokenID] = now.Add(is.ttl)
	return nil
}

// sweep drops blocklist entries past their time.
func (is *Issuer) sweep() {
	is.mu.Lock()
	defer is.mu.Unlock()
	now := is.now()
	for id, until := range is.blocked {
		if !now.Before(until) {
			delete(is.blocked, id)
		}
	}
}

// Authorize is the check before a side effect: a valid, unrevoked token, then the gate's live
// answer for action.
func (is *Issuer) Authorize(ctx context.Context, g Gate, tok, action string) error {
	c, err := is.Verify(tok)
	if err != nil {
		return err
	}
	is.sweep()
	is.mu.Lock()
	_, revoked := is.blocked[c.ID]
	is.mu.Unlock()
	if revoked {
		return ErrRevoked
	}
	return g.Allow(ctx, c, action)
}
