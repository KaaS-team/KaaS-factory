// Ported from anthropics/claude-code-action@8a29bc6 src/github/validation/trigger.ts (with actor.ts and utils/actor-filter.ts)
// Copyright (c) 2025 Anthropic, PBC. MIT licence; see THIRD_PARTY_NOTICES.md.

package github

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

const botSuffix = "[bot]"

// SameLogin reports whether a and b name the same account. Logins are case-insensitive, a "[bot]"
// suffix is ignored, and an empty login matches nothing.
func SameLogin(a, b string) bool {
	return a != "" && b != "" && strings.EqualFold(strings.TrimSuffix(strings.ToLower(a), botSuffix), strings.TrimSuffix(strings.ToLower(b), botSuffix))
}

// BotLogin returns login lower-cased with the "[bot]" suffix REST uses, which GraphQL leaves off.
func BotLogin(login string) string {
	return strings.TrimSuffix(strings.ToLower(login), botSuffix) + botSuffix
}

// EventKind is the GitHub object an Event is about.
type EventKind string

// The event kinds the trigger rules distinguish.
const (
	EvComment EventKind = "comment"
	EvReview  EventKind = "review"
	EvIssue   EventKind = "issue"
)

// Event is the part of a GitHub event the trigger rules read. Actor is who caused it; Author wrote
// the comment or review; Label and Assignee are those the event names.
type Event struct {
	Kind            EventKind
	Action          string
	Actor, Author   string
	Label, Assignee string
}

// TriggerConfig names the label and assignee that start a run. An empty one never matches.
type TriggerConfig struct{ Label, Assignee string }

// Fires reports whether e may start a run. Deleting or editing someone else's comment or review
// fires an event with the moderator as actor, so the text must come from the actor; a label or an
// assignment fires only when it is the configured one.
func (e Event) Fires(cfg TriggerConfig) bool {
	switch e.Kind {
	case EvComment:
		return e.Action != "deleted" && SameLogin(e.Author, e.Actor)
	case EvReview:
		return SameLogin(e.Author, e.Actor)
	case EvIssue:
		switch e.Action {
		case "labeled":
			return cfg.Label != "" && strings.EqualFold(e.Label, cfg.Label)
		case "assigned":
			want := strings.TrimPrefix(cfg.Assignee, "@")
			return want != "" && e.Assignee == want
		}
	}
	return false
}

// AllowedBot reports whether actor is on the comma-separated allow list, or the list is "*".
func AllowedBot(actor, list string) bool {
	list = strings.TrimSpace(list)
	if list == "*" {
		return true
	}
	for _, b := range strings.Split(list, ",") {
		if b = strings.TrimSpace(b); b != "" && SameLogin(b, actor) {
			return true
		}
	}
	return false
}

// ErrNoSuchUser is what a KindOf lookup returns for an actor GitHub cannot resolve, such as an App
// without a backing user account.
var ErrNoSuchUser = errors.New("github tracker: no such user")

// KindOf looks up a login's account type ("User", "Bot", "Organization").
type KindOf func(ctx context.Context, login string) (string, error)

// CheckActor reports whether actor is a human, or a bot on the allow list. The allow list never
// applies to a User account. A failed lookup is an error and refuses the actor.
func CheckActor(ctx context.Context, kindOf KindOf, actor, allowedBots string) (bool, error) {
	kind, err := kindOf(ctx, actor)
	switch {
	case errors.Is(err, ErrNoSuchUser):
		return AllowedBot(actor, allowedBots), nil
	case err != nil:
		return false, fmt.Errorf("github tracker: account type of %s: %w", actor, err)
	case kind == "User":
		return true, nil
	case kind == "Bot":
		actor = BotLogin(actor)
	}
	return AllowedBot(actor, allowedBots), nil
}
