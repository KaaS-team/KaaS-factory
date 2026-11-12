// Package cap refuses to dispatch a session whose ticket has already spent its cap. It reads the
// spend from the ledger comment and writes the cap and the spend back beside it.
package cap

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/marker"
	"github.com/KaaS-team/factory/internal/meter"
)

// ErrOverCap is the refusal. Its text is customer-visible, so it names no cost, count or model.
var ErrOverCap = errors.New("session spend cap reached; a human must raise it to continue")

// Gate is the pre-dispatch check. USD of zero or less means no cap.
type Gate struct {
	Thread api.Thread
	Holder string // ledger rows from other holders do not count
	USD    float64
	Now    func() time.Time // names today for the window; default time.Now
}

// Record is the cap marker on the ledger comment: the cap and the spend it was judged against.
type Record struct {
	CapUSD   float64
	SpentUSD float64
}

// Read returns the cap marker in a ledger comment body.
func Read(body string) (Record, bool) {
	objs := marker.Find(body, "cap")
	if len(objs) == 0 {
		return Record{}, false
	}
	var w struct {
		Cap   *float64 `json:"capUsd"`
		Spent *float64 `json:"spentUsd"`
	}
	if json.Unmarshal([]byte(objs[len(objs)-1]), &w) != nil || w.Cap == nil || w.Spent == nil {
		return Record{}, false
	}
	return Record{CapUSD: *w.Cap, SpentUSD: *w.Spent}, true
}

// Allow returns ErrOverCap when the ticket's recorded spend has reached the cap, and nil otherwise.
// It writes the cap and the spend to the ledger comment first, only when they changed.
func (g Gate) Allow(ctx context.Context, id api.TicketID) error {
	if g.USD <= 0 {
		return nil
	}
	body, err := g.Thread.SpendComment(ctx, id)
	if err != nil {
		return err
	}
	spends, err := meter.DecodeSpend(body)
	if err != nil {
		return err
	}
	now := g.Now
	if now == nil {
		now = time.Now
	}
	spent := meter.InWindow(spends, g.Holder, now().UTC().Format("2006-01-02"))
	rec := Record{CapUSD: g.USD, SpentUSD: spent}
	if old, ok := Read(body); !ok || old != rec {
		if err := g.Thread.PutSpendComment(ctx, id, withRecord(body, rec)); err != nil {
			return err
		}
	}
	if spent >= g.USD {
		return ErrOverCap
	}
	return nil
}

// withRecord returns body with its cap markers replaced by one for rec.
func withRecord(body string, rec Record) string {
	for _, o := range marker.Find(body, "cap") {
		body = strings.Replace(body, marker.Wrap("cap", o), "", 1)
	}
	body = strings.TrimRight(body, "\n")
	if body != "" {
		body += "\n"
	}
	return body + marker.Wrap("cap", `{"capUsd":`+num(rec.CapUSD)+`,"spentUsd":`+num(rec.SpentUSD)+`}`)
}

func num(f float64) string {
	b, _ := json.Marshal(math.Round(f*1e6) / 1e6) // a finite float always encodes
	return string(b)
}
