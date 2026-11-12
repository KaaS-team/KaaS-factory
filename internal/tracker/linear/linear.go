// Package linear implements api.Tracker over Linear's GraphQL API for one team. Queries and
// request shapes follow src/adapters/trackers/linear.ts, which tests pin with recorded bodies.
package linear

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/tracker/vendorkit"
)

// Config says which team to read, how to authenticate and how factory phases map to states.
type Config struct {
	Team       string               // team key, "ENG" for ENG-42
	TokenEnv   string               // name of the env var holding the API key, never the key
	BaseURL    string               // default https://api.linear.app
	ReadyState string               // workflow state name that marks a ticket ready
	ReadyLabel string               // label name that marks a ticket ready
	Phases     map[api.Phase]string // phase to workflow state name; only these states are written
	Getenv     func(string) string  // default os.Getenv
	Client     *vendorkit.Client    // timeout and retry policy, default zero value
}

var (
	_ api.Lister = (*Tracker)(nil)
	_ api.Thread = (*Tracker)(nil)
)

// Tracker is a Linear-backed api.Tracker.
type Tracker struct {
	cfg  Config
	http *vendorkit.Client
}

const issueFields = `id number title description state { type } creator { id } createdAt labels { nodes { id name updatedAt } }
  comments(first: 250) { nodes { id body createdAt user { id } } }`

// Named operations, as in the TS adapter. Team and IssueState are the Go adapter's own: the TS
// Team query has no state names, which the phase map needs.
var (
	qIssue  = `query Issue($id: String!) { issue(id: $id) { ` + issueFields + ` } }`
	qIssues = `query Issues($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 100, after: $after) {
    nodes { ` + issueFields + ` } pageInfo { hasNextPage endCursor } } }`
	qTeam = `query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id
    states { nodes { id name type position } } } } }`
	qIssueState    = `query IssueState($id: String!) { issue(id: $id) { id state { id name } } }`
	qCommentCreate = "mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }"
	qCommentUpdate = "mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }"
	qIssueUpdate   = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success } }`
)

// New checks the config and returns a tracker. It makes no request.
func New(cfg Config) (*Tracker, error) {
	switch {
	case cfg.Team == "":
		return nil, errors.New("linear: team is required")
	case cfg.TokenEnv == "":
		return nil, errors.New("linear: token_env is required")
	case cfg.ReadyState == "" && cfg.ReadyLabel == "":
		return nil, errors.New("linear: set ready_state or ready_label")
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.linear.app"
	}
	if cfg.Getenv == nil {
		cfg.Getenv = os.Getenv
	}
	c := cfg.Client
	if c == nil {
		c = &vendorkit.Client{}
	}
	return &Tracker{cfg: cfg, http: c}, nil
}

// Name is "linear".
func (t *Tracker) Name() string { return "linear" }

type issue struct {
	ID       string `json:"id"`
	Comments struct {
		Nodes []struct{ ID, Body string } `json:"nodes"`
	} `json:"comments"`
	Number      int     `json:"number"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
	CreatedAt   string  `json:"createdAt"`
	Labels      struct {
		Nodes []struct {
			Name string `json:"name"`
		} `json:"nodes"`
	} `json:"labels"`
}

func (t *Tracker) token() (string, error) {
	tok := t.cfg.Getenv(t.cfg.TokenEnv)
	if tok == "" {
		return "", fmt.Errorf("linear: env var %s is not set", t.cfg.TokenEnv)
	}
	return tok, nil
}

func (t *Tracker) gql(ctx context.Context, query string, vars map[string]any, out any) error {
	tok, err := t.token()
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"query": query, "variables": vars})
	if err != nil {
		return err
	}
	h := http.Header{"Authorization": {tok}, "Content-Type": {"application/json"}, "Accept": {"application/json"}}
	raw, err := t.http.Do(ctx, http.MethodPost, strings.TrimRight(t.cfg.BaseURL, "/")+"/graphql", h, body)
	if err != nil {
		return fmt.Errorf("linear: %w", err)
	}
	var res struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("linear: bad response: %w", err)
	}
	if len(res.Errors) > 0 || len(res.Data) == 0 || string(res.Data) == "null" {
		msg := "no data"
		if len(res.Errors) > 0 {
			msg = res.Errors[0].Message
		}
		return fmt.Errorf("linear: %s", msg)
	}
	return json.Unmarshal(res.Data, out)
}

func (t *Tracker) ticket(i issue) api.Ticket {
	tk := api.Ticket{ID: api.TicketID(fmt.Sprintf("%s-%d", t.cfg.Team, i.Number)), Title: i.Title}
	if i.Description != nil {
		tk.Body = *i.Description
	}
	for _, l := range i.Labels.Nodes {
		tk.Labels = append(tk.Labels, l.Name)
	}
	tk.CreatedAt, _ = time.Parse(time.RFC3339, i.CreatedAt)
	return tk
}

func (t *Tracker) readyFilter() map[string]any {
	team := map[string]any{"key": map[string]any{"eq": t.cfg.Team}}
	open := map[string]any{"type": map[string]any{"nin": []string{"completed", "canceled"}}}
	state := map[string]any{"name": map[string]any{"eq": t.cfg.ReadyState}}
	label := map[string]any{"name": map[string]any{"eq": t.cfg.ReadyLabel}}
	switch {
	case t.cfg.ReadyState != "" && t.cfg.ReadyLabel != "":
		return map[string]any{"team": team, "or": []any{map[string]any{"state": state}, map[string]any{"state": open, "labels": label}}}
	case t.cfg.ReadyState != "":
		return map[string]any{"team": team, "state": state}
	}
	return map[string]any{"team": team, "state": open, "labels": label}
}

// Ready lists open issues in the ready state or carrying the ready label.
func (t *Tracker) Ready(ctx context.Context) ([]api.Ticket, error) {
	return t.list(ctx, t.readyFilter())
}

// activeStatuses are the state names mapped to a phase from claimed to merge-queue, sorted. A name
// that also maps to a finished or parked phase (ready, done, merged, needs-human, canceled) is left out.
func (t *Tracker) activeStatuses() []string {
	active := map[string]bool{}
	for _, p := range []api.Phase{api.PhaseClaimed, api.PhaseRunning, api.PhaseStalled, api.PhaseRetryQueue, api.PhaseQueued} {
		if n := t.cfg.Phases[p]; n != "" {
			active[n] = true
		}
	}
	for _, p := range []api.Phase{api.PhaseReady, api.PhaseDone, api.PhaseMerged, api.PhaseNeedsHuman, api.PhaseCanceled} {
		delete(active, t.cfg.Phases[p])
	}
	out := make([]string, 0, len(active))
	for n := range active {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// Active lists issues sitting in a state mapped to a phase from claimed to merge-queue, in one
// Issues query (Symphony §14). With no such state mapped it returns nothing and makes no request.
func (t *Tracker) Active(ctx context.Context) ([]api.Ticket, error) {
	names := t.activeStatuses()
	if len(names) == 0 {
		return nil, nil
	}
	return t.list(ctx, map[string]any{
		"team":  map[string]any{"key": map[string]any{"eq": t.cfg.Team}},
		"state": map[string]any{"name": map[string]any{"in": names}},
	})
}

func (t *Tracker) list(ctx context.Context, filter map[string]any) ([]api.Ticket, error) {
	var out []api.Ticket
	var after any
	for {
		var d struct {
			Issues struct {
				Nodes    []issue `json:"nodes"`
				PageInfo struct {
					HasNextPage bool    `json:"hasNextPage"`
					EndCursor   *string `json:"endCursor"`
				} `json:"pageInfo"`
			} `json:"issues"`
		}
		if err := t.gql(ctx, qIssues, map[string]any{"filter": filter, "after": after}, &d); err != nil {
			return nil, err
		}
		for _, i := range d.Issues.Nodes {
			out = append(out, t.ticket(i))
		}
		if !d.Issues.PageInfo.HasNextPage || d.Issues.PageInfo.EndCursor == nil {
			return out, nil
		}
		after = *d.Issues.PageInfo.EndCursor
	}
}

func (t *Tracker) raw(ctx context.Context, id api.TicketID) (issue, error) {
	var d struct {
		Issue *issue `json:"issue"`
	}
	if err := t.gql(ctx, qIssue, map[string]any{"id": string(id)}, &d); err != nil {
		return issue{}, err
	}
	if d.Issue == nil {
		return issue{}, fmt.Errorf("linear: no issue %s", id)
	}
	return *d.Issue, nil
}

// Get returns one issue by key, such as ENG-42.
func (t *Tracker) Get(ctx context.Context, id api.TicketID) (api.Ticket, error) {
	i, err := t.raw(ctx, id)
	if err != nil {
		return api.Ticket{}, err
	}
	return t.ticket(i), nil
}

// Comment adds a comment. Markers survive Linear's comment stripping through a sealed footer.
func (t *Tracker) Comment(ctx context.Context, id api.TicketID, body string) error {
	tok, err := t.token()
	if err != nil {
		return err
	}
	i, err := t.raw(ctx, id)
	if err != nil {
		return err
	}
	in := map[string]any{"issueId": i.ID, "body": vendorkit.EncodeBody(body, vendorkit.HMACSeal(tok), "comment")}
	var d json.RawMessage
	return t.gql(ctx, qCommentCreate, map[string]any{"input": in}, &d)
}

func (t *Tracker) owned(name string) bool {
	if name == t.cfg.ReadyState {
		return true
	}
	for _, s := range t.cfg.Phases {
		if s == name {
			return true
		}
	}
	return false
}

// SetPhase moves the issue to the state mapped to p. A phase with no mapping is an error, and an
// issue sitting in a state the factory does not own is left alone.
func (t *Tracker) SetPhase(ctx context.Context, id api.TicketID, p api.Phase) error {
	target, ok := t.cfg.Phases[p]
	if !ok || target == "" {
		return fmt.Errorf("linear: no state mapped for phase %q", p)
	}
	var cur struct {
		Issue *struct {
			ID    string `json:"id"`
			State struct {
				Name string `json:"name"`
			} `json:"state"`
		} `json:"issue"`
	}
	if err := t.gql(ctx, qIssueState, map[string]any{"id": string(id)}, &cur); err != nil {
		return err
	}
	if cur.Issue == nil {
		return fmt.Errorf("linear: no issue %s", id)
	}
	if cur.Issue.State.Name == target {
		return nil
	}
	if !t.owned(cur.Issue.State.Name) {
		return fmt.Errorf("linear: %s is in state %q, which the factory does not own", id, cur.Issue.State.Name)
	}
	var team struct {
		Teams struct {
			Nodes []struct {
				States struct {
					Nodes []struct{ ID, Name string } `json:"nodes"`
				} `json:"states"`
			} `json:"nodes"`
		} `json:"teams"`
	}
	if err := t.gql(ctx, qTeam, map[string]any{"key": t.cfg.Team}, &team); err != nil {
		return err
	}
	if len(team.Teams.Nodes) == 0 {
		return fmt.Errorf("linear: no team with key %s", t.cfg.Team)
	}
	for _, s := range team.Teams.Nodes[0].States.Nodes {
		if s.Name == target {
			var d json.RawMessage
			return t.gql(ctx, qIssueUpdate, map[string]any{"id": cur.Issue.ID, "input": map[string]any{"stateId": s.ID}}, &d)
		}
	}
	return fmt.Errorf("linear: team %s has no state %q (mapped from phase %q)", t.cfg.Team, target, p)
}

// spend finds the issue's spend comment: the one whose sealed footer holds and whose original
// carries the marker. It returns the issue id, the comment id and the original body.
func (t *Tracker) spend(ctx context.Context, id api.TicketID) (issueID, commentID, body string, err error) {
	tok, err := t.token()
	if err != nil {
		return "", "", "", err
	}
	i, err := t.raw(ctx, id)
	if err != nil {
		return "", "", "", err
	}
	for _, c := range i.Comments.Nodes {
		if b, ok := vendorkit.DecodeBody(c.Body, vendorkit.HMACSeal(tok), "comment"); ok && strings.Contains(b, vendorkit.SpendMarker) {
			return i.ID, c.ID, b, nil
		}
	}
	return i.ID, "", "", nil
}

// SpendComment returns the spend ledger comment on the issue, or "" when none exists.
func (t *Tracker) SpendComment(ctx context.Context, id api.TicketID) (string, error) {
	_, _, b, err := t.spend(ctx, id)
	return b, err
}

// PutSpendComment updates the issue's spend ledger comment in place, or adds it the first time.
func (t *Tracker) PutSpendComment(ctx context.Context, id api.TicketID, body string) error {
	_, c, _, err := t.spend(ctx, id)
	if err != nil {
		return err
	}
	if c == "" {
		return t.Comment(ctx, id, body)
	}
	tok, _ := t.token()
	var d json.RawMessage
	return t.gql(ctx, qCommentUpdate, map[string]any{"id": c, "input": map[string]any{"body": vendorkit.EncodeBody(body, vendorkit.HMACSeal(tok), "comment")}}, &d)
}
