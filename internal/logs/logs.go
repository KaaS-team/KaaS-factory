// Package logs prints what a ticket's session is doing: `factory logs <ticket> [-f]`.
//
// A Source yields pages of events from one session, from the routines API or
// a local output file. Print turns them into lines and, when following, keeps
// polling until the session ends or the context is canceled. Every line is
// redacted before it is written.
package logs

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

// DefaultInterval is how often follow mode polls a remote run log.
const DefaultInterval = 5 * time.Second

// Event is one entry of a session's run log. ID is empty for sources with no
// stable ids; Print then does not dedupe by id.
type Event struct {
	ID   string    `json:"id,omitempty"`
	Time time.Time `json:"time"`
	Kind string    `json:"kind"`
	Text string    `json:"text"`
}

// Page is one poll result. Next is the cursor to pass to the following poll,
// More says another page is ready now, and Done says the session has ended
// and the page holds its last events.
type Page struct {
	Events []Event
	Next   string
	More   bool
	Done   bool
}

// Source reads a session's events after a cursor ("" for the start).
type Source interface {
	Poll(ctx context.Context, cursor string) (Page, error)
}

// Options controls Print.
type Options struct {
	Follow   bool
	JSON     bool
	Interval time.Duration // zero means DefaultInterval
}

// Print writes src's events to w, one per line, each exactly once. Without
// Follow it reads what exists now and returns. With Follow it polls every
// Interval until the session ends (nil) or ctx is canceled (ctx's error).
func Print(ctx context.Context, w io.Writer, src Source, o Options) error {
	if o.Interval <= 0 {
		o.Interval = DefaultInterval
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := src.Poll(ctx, cursor)
		if err != nil {
			return err
		}
		for _, e := range page.Events {
			if e.ID != "" {
				if seen[e.ID] {
					continue
				}
				seen[e.ID] = true
			}
			if err := writeEvent(w, e, o.JSON); err != nil {
				return err
			}
		}
		cursor = page.Next
		if page.Done {
			return nil
		}
		if page.More {
			continue
		}
		if !o.Follow {
			return nil
		}
		t := time.NewTimer(o.Interval)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case <-t.C:
		}
	}
}

func writeEvent(w io.Writer, e Event, asJSON bool) error {
	e.Kind, e.Text = Redact(e.Kind), Redact(e.Text)
	if asJSON {
		raw, err := json.Marshal(struct {
			Time time.Time `json:"time"`
			Kind string    `json:"kind"`
			Text string    `json:"text"`
		}{e.Time.UTC(), e.Kind, e.Text})
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(w, "%s\n", raw)
		return err
	}
	text := strings.NewReplacer("\r\n", " ", "\n", " ", "\r", " ").Replace(e.Text)
	_, err := fmt.Fprintf(w, "%s  %s  %s\n", e.Time.UTC().Format(time.RFC3339), e.Kind, text)
	return err
}

// credentialRE lists the token shapes the gate redacts (copied from the v8
// src/mc/redact.ts; another session moves the list into internal/gate).
var credentialRE = []*regexp.Regexp{
	regexp.MustCompile(`//[^\s/@:]+:[^\s/@]+@`),
	regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]{8,}`),
	regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{20,}`),
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{20,}`),
	regexp.MustCompile(`\bsk-(ant-)?[A-Za-z0-9_-]{16,}`),
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\bxox[abpr]-[A-Za-z0-9-]{10,}`),
	regexp.MustCompile(`\beyJ[\w-]+\.[\w-]+\.[\w-]+`),
	regexp.MustCompile(`(?i)[?&](token|access_token|key|api_key|secret|sig|signature|code|auth)=[^&\s#]*`),
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
}

// Redact replaces every token-shaped substring of s with "[redacted]".
func Redact(s string) string {
	for _, re := range credentialRE {
		s = re.ReplaceAllString(s, "[redacted]")
	}
	return s
}
