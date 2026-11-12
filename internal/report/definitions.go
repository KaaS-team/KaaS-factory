package report

import (
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// These functions are the only place the report's terms are defined.
//
//	merged PR           a ticket whose PR merged inside the window
//	tokens              input + output + cache read + cache write
//	tokens per merged   all tokens on merged tickets, failed attempts included, over merged PRs
//	rework              attempts above one, per ticket
//	human touch         a /factory chatops command or a manual push on the ticket branch
//	cycle time          first dispatch to merge

// Merged reports whether r's PR merged inside w.
func Merged(r TicketRecord, w Window) bool {
	if r.MergedAt.IsZero() {
		return false
	}
	return !r.MergedAt.Before(w.Since) && r.MergedAt.Before(w.Until)
}

// Tokens is every token a usage record counts.
func Tokens(u api.Usage) int64 {
	return u.InputTokens + u.OutputTokens + u.CacheReadTokens + u.CacheWriteTokens
}

// TicketTokens is all tokens spent on r, failed attempts included.
func TicketTokens(r TicketRecord) int64 {
	var n int64
	for _, a := range r.Attempts {
		n += Tokens(a.Usage)
	}
	return n
}

// Rework is the number of attempts on r above the first.
func Rework(r TicketRecord) int {
	return max(len(r.Attempts)-1, 0)
}

// HumanTouches is the count of chatops commands plus manual pushes on r.
func HumanTouches(r TicketRecord) int { return r.ChatopsCommands + r.ManualPushes }

// CycleTime is first dispatch to merge; ok is false when either end is missing or out of order.
func CycleTime(r TicketRecord) (d time.Duration, ok bool) {
	if r.FirstDispatch.IsZero() || r.MergedAt.IsZero() || r.MergedAt.Before(r.FirstDispatch) {
		return 0, false
	}
	return r.MergedAt.Sub(r.FirstDispatch), true
}
