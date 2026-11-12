// Package safeout is the agent write path: a session emits typed NDJSON items,
// and a separate apply stage, the only holder of a tracker write credential,
// validates each against a per-verb policy and executes it.
package safeout

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// Item is one parsed NDJSON line. Line is its 1-based line number in the input.
type Item struct {
	Line   int
	Verb   string
	Body   string
	Title  string
	Labels []string
}

// Outcome states recorded for every line.
const (
	Applied = "applied"
	Staged  = "staged"
	Dropped = "dropped"
)

// Result is what happened to one input line.
type Result struct {
	Line    int
	Verb    string
	Outcome string
	Reason  string
}

// Writer is the narrow write surface the apply stage needs; it holds the credential.
type Writer interface {
	Comment(ctx context.Context, ticket, body string) error
	AddLabels(ctx context.Context, ticket string, labels []string) error
	CreateIssue(ctx context.Context, title, body string, labels []string) (string, error)
}

// Ledger records each item and its outcome in the spend/audit ledger.
type Ledger interface {
	Record(ctx context.Context, r Result) error
}

// VerbPolicy limits one verb. Max is a positive count or -1 for unlimited.
// Labels, when set, is the allowed label list. TitlePrefix is required on titles.
// Expires, when positive, stamps created issues with an expiry marker.
// Staged logs the item without writing.
type VerbPolicy struct {
	Max         int
	Labels      []string
	TitlePrefix string
	Expires     time.Duration
	Staged      bool
}

// Policy maps a verb ("comment", "add_labels", "create_issue") to its limits.
// A verb absent from the map is not allowed.
type Policy map[string]VerbPolicy

// ValidMax reports whether n is a legal max: positive or -1.
func ValidMax(n int) bool { return n > 0 || n == -1 }

// Validate checks every verb's max.
func (p Policy) Validate() error {
	for v, vp := range p {
		if !ValidMax(vp.Max) {
			return fmt.Errorf("safeout: verb %q: max must be positive or -1, got %d", v, vp.Max)
		}
	}
	return nil
}

type rawItem struct {
	Type   string   `json:"type"`
	Body   string   `json:"body"`
	Title  string   `json:"title"`
	Labels []string `json:"labels"`
}

// Parse reads NDJSON tolerantly: blank lines are skipped, and each bad line is
// reported with its line number while later lines are still read.
func Parse(r io.Reader) ([]Item, []Result, error) {
	var items []Item
	var bad []Result
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	n := 0
	for sc.Scan() {
		n++
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var ri rawItem
		if err := json.Unmarshal([]byte(line), &ri); err != nil {
			bad = append(bad, Result{Line: n, Outcome: Dropped, Reason: "invalid JSON: " + err.Error()})
			continue
		}
		if ri.Type == "" {
			bad = append(bad, Result{Line: n, Outcome: Dropped, Reason: "missing type"})
			continue
		}
		items = append(items, Item{Line: n, Verb: ri.Type, Body: ri.Body, Title: ri.Title, Labels: ri.Labels})
	}
	return items, bad, sc.Err()
}

// check returns a drop reason for an item, or "".
func (p Policy) check(it Item) string {
	vp, ok := p[it.Verb]
	if !ok {
		return "verb not allowed: " + it.Verb
	}
	switch it.Verb {
	case "comment":
		if strings.TrimSpace(it.Body) == "" {
			return "empty body"
		}
	case "add_labels":
		if len(it.Labels) == 0 {
			return "no labels"
		}
		for _, l := range it.Labels {
			if len(vp.Labels) > 0 && !contains(vp.Labels, l) {
				return "label not allowed: " + l
			}
		}
	case "create_issue":
		if strings.TrimSpace(it.Title) == "" {
			return "empty title"
		}
		if !strings.HasPrefix(it.Title, vp.TitlePrefix) {
			return "title lacks prefix " + vp.TitlePrefix
		}
		for _, l := range it.Labels {
			if len(vp.Labels) > 0 && !contains(vp.Labels, l) {
				return "label not allowed: " + l
			}
		}
	default:
		return "unknown verb: " + it.Verb
	}
	return ""
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// Apply validates items against the policy and executes the valid ones through w.
// Invalid items are dropped and reported; valid ones still run. Every result,
// including the earlier parse rejects passed in bad, is recorded in the ledger.
// sanitize, when non-nil, cleans each body and title before it is written.
func Apply(ctx context.Context, ticket string, items []Item, bad []Result, p Policy, w Writer, led Ledger, now time.Time, sanitize func(string) string) ([]Result, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if sanitize == nil {
		sanitize = func(s string) string { return s }
	}
	out := append([]Result(nil), bad...)
	count := map[string]int{}
	for _, it := range items {
		res := Result{Line: it.Line, Verb: it.Verb}
		if reason := p.check(it); reason != "" {
			res.Outcome, res.Reason = Dropped, reason
		} else if vp := p[it.Verb]; vp.Max != -1 && count[it.Verb] >= vp.Max {
			res.Outcome, res.Reason = Dropped, fmt.Sprintf("over max %d", vp.Max)
		} else {
			count[it.Verb]++
			if vp.Staged {
				res.Outcome = Staged
			} else if err := write(ctx, w, ticket, it, vp, now, sanitize); err != nil {
				res.Outcome, res.Reason = Dropped, "write failed: "+err.Error()
			} else {
				res.Outcome = Applied
			}
		}
		out = append(out, res)
	}
	for _, r := range out {
		if err := led.Record(ctx, r); err != nil {
			return out, err
		}
	}
	return out, nil
}

func write(ctx context.Context, w Writer, ticket string, it Item, vp VerbPolicy, now time.Time, sanitize func(string) string) error {
	switch it.Verb {
	case "comment":
		return w.Comment(ctx, ticket, sanitize(it.Body))
	case "add_labels":
		return w.AddLabels(ctx, ticket, it.Labels)
	default:
		body := sanitize(it.Body)
		if vp.Expires > 0 {
			body += "\n\n<!-- factory:expires " + now.Add(vp.Expires).UTC().Format(time.RFC3339) + " -->"
		}
		_, err := w.CreateIssue(ctx, sanitize(it.Title), body, it.Labels)
		return err
	}
}
