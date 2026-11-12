// Package depup turns dependency updates into tickets with declarative rules, no model call.
package depup

import (
	"fmt"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
)

// Label marks every ticket this package creates.
const Label = "depup"

// Type is the semver size of an update.
type Type string

// The update types a rule can match.
const (
	Major Type = "major"
	Minor Type = "minor"
	Patch Type = "patch"
)

// Reasons recorded on a decision that creates no ticket.
const (
	SkipDisabled  = "disabled by rule"
	SkipCollision = "collision: same file, dependency and current version"
)

// Update is one available dependency upgrade.
type Update struct {
	Package, File, Current, New string
	Type                        Type
}

// Key is the collision key file:dep:current.
func (u Update) Key() string { return u.File + ":" + u.Package + ":" + u.Current }

// Match selects updates; an empty field matches anything. Globs use * for any run of characters.
type Match struct {
	Packages []string
	Types    []Type
	Files    []string
}

// Rule sets fields on every update it matches; nil and empty fields leave earlier rules' values alone.
type Rule struct {
	Match     Match
	GroupName string
	Enabled   *bool
	Automerge *bool
}

// Decision is the outcome for one update. SkipReason is empty when a ticket will be made.
type Decision struct {
	Update
	Enabled    bool
	Automerge  bool
	Group      string
	SkipReason string
}

// Evaluate applies rules in order (the last matching rule wins per field), then filters collisions
// against inflight keys and earlier updates in the batch.
func Evaluate(rules []Rule, ups []Update, inflight map[string]bool) []Decision {
	seen := map[string]bool{}
	out := make([]Decision, 0, len(ups))
	for _, u := range ups {
		d := Decision{Update: u, Enabled: true}
		for _, r := range rules {
			if !r.Match.matches(u) {
				continue
			}
			if r.Enabled != nil {
				d.Enabled = *r.Enabled
			}
			if r.Automerge != nil {
				d.Automerge = *r.Automerge
			}
			if r.GroupName != "" {
				d.Group = r.GroupName
			}
		}
		switch {
		case !d.Enabled:
			d = Decision{Update: u, SkipReason: SkipDisabled}
		case inflight[u.Key()] || seen[u.Key()]:
			d = Decision{Update: u, SkipReason: SkipCollision}
		default:
			seen[u.Key()] = true
		}
		out = append(out, d)
	}
	return out
}

func (m Match) matches(u Update) bool {
	return anyGlob(m.Packages, u.Package) && anyGlob(m.Files, u.File) && (len(m.Types) == 0 || hasType(m.Types, u.Type))
}

func hasType(ts []Type, t Type) bool {
	for _, x := range ts {
		if x == t {
			return true
		}
	}
	return false
}

func anyGlob(pats []string, s string) bool {
	if len(pats) == 0 {
		return true
	}
	for _, p := range pats {
		if glob(p, s) {
			return true
		}
	}
	return false
}

// glob matches s against p where * stands for any run of characters, slashes included.
func glob(p, s string) bool {
	parts := strings.Split(p, "*")
	if len(parts) == 1 {
		return p == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	last := parts[len(parts)-1]
	for _, mid := range parts[1 : len(parts)-1] {
		i := strings.Index(s, mid)
		if i < 0 {
			return false
		}
		s = s[i+len(mid):]
	}
	return strings.HasSuffix(s, last)
}

// Tickets makes one ticket per group and one per ungrouped update, in first-seen order.
// A ticket carries the automerge label only when every update in it asks for it.
func Tickets(ds []Decision, repo string) []api.Ticket {
	var order []string
	batches := map[string][]Decision{}
	for i, d := range ds {
		if d.SkipReason != "" {
			continue
		}
		k := "g:" + d.Group
		if d.Group == "" {
			k = fmt.Sprintf("u:%d", i)
		}
		if _, ok := batches[k]; !ok {
			order = append(order, k)
		}
		batches[k] = append(batches[k], d)
	}
	out := make([]api.Ticket, 0, len(order))
	for _, k := range order {
		b := batches[k]
		t := api.Ticket{Repo: repo, Labels: []string{Label}}
		auto := true
		var body []string
		files := map[string]bool{}
		for _, d := range b {
			auto = auto && d.Automerge
			body = append(body, fmt.Sprintf("- %s %s -> %s (%s) in %s", d.Package, d.Current, d.New, d.Type, d.File))
			if !files[d.File] {
				files[d.File] = true
				t.Files = append(t.Files, d.File)
			}
		}
		if b[0].Group != "" {
			t.Title = fmt.Sprintf("Update group %s (%d dependencies)", b[0].Group, len(b))
		} else {
			t.Title = fmt.Sprintf("Update %s %s -> %s", b[0].Package, b[0].Current, b[0].New)
		}
		if auto {
			t.Labels = append(t.Labels, "automerge")
		}
		t.Body = strings.Join(body, "\n")
		out = append(out, t)
	}
	return out
}
