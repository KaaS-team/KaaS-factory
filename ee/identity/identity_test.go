//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package identity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeLedger struct{ events []Event }

func (l *fakeLedger) Append(_ context.Context, e Event) error {
	l.events = append(l.events, e)
	return nil
}

type fakeGate struct {
	calls int
	allow bool
}

func (g *fakeGate) Allow(_ context.Context, _ Claims, _ string) error {
	g.calls++
	if !g.allow {
		return errors.New("denied")
	}
	return nil
}

func newIssuer(t *testing.T) (*Issuer, *fakeLedger, *time.Time) {
	t.Helper()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l := &fakeLedger{}
	is, err := NewIssuer([]byte("0123456789abcdef0123456789abcdef"), l, time.Hour, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return is, l, &now
}

var (
	human    = Principal{ID: "ana", Kind: KindHuman}
	operator = Principal{ID: "ops", Kind: KindOperator}
	agent    = Principal{ID: "a1", Kind: KindAgent}
)

func TestNewIssuerRejectsShortKey(t *testing.T) {
	if _, err := NewIssuer([]byte("short"), &fakeLedger{}, time.Hour, time.Now); err == nil {
		t.Fatal("want error for a short key")
	}
}

// Only human or operator principals may mint; an agent token cannot mint another.
func TestMintPrincipals(t *testing.T) {
	for _, tc := range []struct {
		name    string
		who     Principal
		wantErr bool
	}{
		{"human", human, false},
		{"operator", operator, false},
		{"agent", agent, true},
		{"unknown kind", Principal{ID: "x", Kind: "robot"}, true},
		{"empty id", Principal{Kind: KindHuman}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			is, l, _ := newIssuer(t)
			tok, err := is.Mint(context.Background(), tc.who, "a1", "run-1", "acme")
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr && (tok != "" || len(l.events) != 0) {
				t.Fatalf("refused mint left token %q or events %v", tok, l.events)
			}
		})
	}
}

func TestMintRequiresIdentityFields(t *testing.T) {
	is, _, _ := newIssuer(t)
	for _, a := range [][3]string{{"", "r", "t"}, {"a", "", "t"}, {"a", "r", ""}} {
		if _, err := is.Mint(context.Background(), human, a[0], a[1], a[2]); err == nil {
			t.Errorf("want error for %v", a)
		}
	}
}

// The token carries identity only: exactly agent id, run id, tenant, delegator, jti and times.
func TestTokenCarriesNoScopes(t *testing.T) {
	is, _, _ := newIssuer(t)
	tok, _ := is.Mint(context.Background(), human, "a1", "run-1", "acme")
	raw, err := base64.RawURLEncoding.DecodeString(strings.Split(tok, ".")[0])
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"agent": true, "run": true, "tenant": true, "delegator": true, "jti": true, "exp": true}
	for k := range m {
		if !want[k] {
			t.Errorf("unexpected claim %q: tokens carry identity, never scopes", k)
		}
	}
	for k := range want {
		if _, ok := m[k]; !ok {
			t.Errorf("missing claim %q", k)
		}
	}
	c, err := is.Verify(tok)
	if err != nil {
		t.Fatal(err)
	}
	if c.AgentID != "a1" || c.RunID != "run-1" || c.Tenant != "acme" || c.Delegator != "ana" {
		t.Fatalf("claims = %+v", c)
	}
}

func TestVerifyRejects(t *testing.T) {
	is, _, now := newIssuer(t)
	tok, _ := is.Mint(context.Background(), human, "a1", "run-1", "acme")
	other, _, _ := newIssuer(t)
	other.key = []byte("ffffffffffffffffffffffffffffffff")
	foreign, _ := other.Mint(context.Background(), human, "a1", "run-1", "acme")
	parts := strings.Split(tok, ".")
	for _, tc := range []struct {
		name, tok string
		advance   time.Duration
	}{
		{"empty", "", 0},
		{"no dot", "abc", 0},
		{"bad payload encoding", "!!!." + parts[1], 0},
		{"tampered payload", base64.RawURLEncoding.EncodeToString([]byte(`{"agent":"evil"}`)) + "." + parts[1], 0},
		{"bad signature", parts[0] + ".AAAA", 0},
		{"foreign key", foreign, 0},
		{"expired", tok, 2 * time.Hour},
	} {
		t.Run(tc.name, func(t *testing.T) {
			*now = now.Add(tc.advance)
			defer func() { *now = now.Add(-tc.advance) }()
			if _, err := is.Verify(tc.tok); err == nil {
				t.Fatal("want error")
			}
		})
	}
}

// Revocation takes effect on the next side effect: Authorize fails at once, the gate is not asked.
func TestRevokeTakesEffectOnNextAuthorize(t *testing.T) {
	is, l, _ := newIssuer(t)
	g := &fakeGate{allow: true}
	tok, _ := is.Mint(context.Background(), operator, "a1", "run-1", "acme")
	if err := is.Authorize(context.Background(), g, tok, "merge"); err != nil {
		t.Fatal(err)
	}
	c, _ := is.Verify(tok)
	if err := is.Revoke(context.Background(), human, c.ID, "leaked"); err != nil {
		t.Fatal(err)
	}
	before := g.calls
	if err := is.Authorize(context.Background(), g, tok, "merge"); !errors.Is(err, ErrRevoked) {
		t.Fatalf("err = %v, want ErrRevoked", err)
	}
	if g.calls != before {
		t.Fatal("gate consulted for a revoked token")
	}
	if len(l.events) != 2 || l.events[1].Type != EventRevoke || l.events[1].Principal != "ana" || l.events[1].TokenID != c.ID {
		t.Fatalf("events = %+v", l.events)
	}
}

// The blocklist entry lives until the token would expire, then is dropped.
func TestBlocklistEntryDropsAfterExpiry(t *testing.T) {
	is, _, now := newIssuer(t)
	tok, _ := is.Mint(context.Background(), human, "a1", "run-1", "acme")
	c, _ := is.Verify(tok)
	if err := is.Revoke(context.Background(), human, c.ID, ""); err != nil {
		t.Fatal(err)
	}
	if len(is.blocked) != 1 {
		t.Fatal("entry missing")
	}
	*now = now.Add(2 * time.Hour)
	is.sweep()
	if len(is.blocked) != 0 {
		t.Fatal("entry kept past token expiry")
	}
}

func TestRevokeRefusesAgent(t *testing.T) {
	is, l, _ := newIssuer(t)
	tok, _ := is.Mint(context.Background(), human, "a1", "run-1", "acme")
	c, _ := is.Verify(tok)
	if err := is.Revoke(context.Background(), agent, c.ID, ""); err == nil {
		t.Fatal("an agent revoked a token")
	}
	if len(l.events) != 1 {
		t.Fatalf("events = %+v", l.events)
	}
	if _, err := is.Verify(tok); err != nil {
		t.Fatal(err)
	}
}

// Authority is live: the same token is allowed or denied as the gate decides on each call.
func TestAuthorizeAsksGateEveryCall(t *testing.T) {
	is, _, _ := newIssuer(t)
	g := &fakeGate{allow: true}
	tok, _ := is.Mint(context.Background(), human, "a1", "run-1", "acme")
	if err := is.Authorize(context.Background(), g, tok, "push"); err != nil {
		t.Fatal(err)
	}
	g.allow = false
	if err := is.Authorize(context.Background(), g, tok, "push"); err == nil {
		t.Fatal("token alone granted authority")
	}
	if g.calls != 2 {
		t.Fatalf("gate calls = %d, want 2", g.calls)
	}
	if err := is.Authorize(context.Background(), g, "bogus", "push"); err == nil || g.calls != 2 {
		t.Fatal("invalid token reached the gate")
	}
}

// A nil gate is an error, not a panic, and no token is let through without a gate's answer.
func TestAuthorizeNilGateIsAnError(t *testing.T) {
	is, _, _ := newIssuer(t)
	tok, _ := is.Mint(context.Background(), human, "a1", "run-1", "acme")
	if err := is.Authorize(context.Background(), nil, tok, "push"); err == nil {
		t.Fatal("nil gate authorized")
	}
}

// A failed ledger write fails the mint and the revoke: no unrecorded identity changes.
func TestLedgerFailureFailsOperation(t *testing.T) {
	is, _, _ := newIssuer(t)
	is.ledger = failLedger{}
	if _, err := is.Mint(context.Background(), human, "a1", "r", "t"); err == nil {
		t.Fatal("mint succeeded without a ledger event")
	}
	if err := is.Revoke(context.Background(), human, "x", ""); err == nil || len(is.blocked) != 0 {
		t.Fatal("revoke took effect without a ledger event")
	}
}

type failLedger struct{}

func (failLedger) Append(context.Context, Event) error { return errors.New("down") }
