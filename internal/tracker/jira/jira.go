// Package jira implements api.Tracker over Jira's REST API v3 for one project. Auth, JQL and
// marker handling follow src/adapters/trackers/jira.ts; v3 bodies are Atlassian Document Format.
package jira

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/tracker/vendorkit"
)

// Config says which project to read, how to authenticate and how factory phases map to statuses.
type Config struct {
	BaseURL     string               // site URL, such as https://acme.atlassian.net
	Project     string               // project key, "SHOP" for SHOP-42
	TokenEnv    string               // name of the env var holding the token, never the token
	ReadyStatus string               // status name that marks a ticket ready
	ReadyLabel  string               // label that marks a ticket ready
	Phases      map[api.Phase]string // phase to status name; only these statuses are written
	Getenv      func(string) string  // default os.Getenv
	Client      *vendorkit.Client    // timeout and retry policy, default zero value
}

var (
	_ api.Lister = (*Tracker)(nil)
	_ api.Thread = (*Tracker)(nil)
)

// Tracker is a Jira-backed api.Tracker.
type Tracker struct {
	cfg  Config
	http *vendorkit.Client
}

const fields = "summary,description,labels,status,created"

var keyRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]*-[0-9]+$`)

// New checks the config and returns a tracker. It makes no request.
func New(cfg Config) (*Tracker, error) {
	switch {
	case cfg.BaseURL == "":
		return nil, errors.New("jira: url is required")
	case cfg.Project == "":
		return nil, errors.New("jira: project is required")
	case cfg.TokenEnv == "":
		return nil, errors.New("jira: token_env is required")
	case cfg.ReadyStatus == "" && cfg.ReadyLabel == "":
		return nil, errors.New("jira: set ready_status or ready_label")
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

// Name is "jira".
func (t *Tracker) Name() string { return "jira" }

// auth: Cloud takes `email:api-token` as Basic, Data Center a personal access token as Bearer.
func auth(token string) string {
	if strings.Contains(token, ":") {
		return "Basic " + base64.StdEncoding.EncodeToString([]byte(token))
	}
	return "Bearer " + token
}

func (t *Tracker) token() (string, error) {
	tok := t.cfg.Getenv(t.cfg.TokenEnv)
	if tok == "" {
		return "", fmt.Errorf("jira: env var %s is not set", t.cfg.TokenEnv)
	}
	return tok, nil
}

func (t *Tracker) call(ctx context.Context, method, path string, query url.Values, in, out any) error {
	tok, err := t.token()
	if err != nil {
		return err
	}
	var body []byte
	h := http.Header{"Authorization": {auth(tok)}, "Accept": {"application/json"}}
	if in != nil {
		if body, err = json.Marshal(in); err != nil {
			return err
		}
		h.Set("Content-Type", "application/json")
	}
	u := strings.TrimRight(t.cfg.BaseURL, "/") + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	raw, err := t.http.Do(ctx, method, u, h, body)
	if err != nil {
		return fmt.Errorf("jira: %w", err)
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

type rawIssue struct {
	Key    string `json:"key"`
	Fields struct {
		Summary     string          `json:"summary"`
		Description json.RawMessage `json:"description"`
		Labels      []string        `json:"labels"`
		Created     string          `json:"created"`
		Status      struct {
			Name string `json:"name"`
		} `json:"status"`
	} `json:"fields"`
}

func (t *Tracker) ticket(i rawIssue) api.Ticket {
	created, _ := time.Parse("2006-01-02T15:04:05.000-0700", i.Fields.Created)
	return api.Ticket{
		ID: api.TicketID(i.Key), Title: i.Fields.Summary, Body: adfText(i.Fields.Description),
		Labels: i.Fields.Labels, CreatedAt: created,
	}
}

func jqlString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

func (t *Tracker) readyJQL() string {
	var ready []string
	if t.cfg.ReadyStatus != "" {
		ready = append(ready, "status = "+jqlString(t.cfg.ReadyStatus))
	}
	if t.cfg.ReadyLabel != "" {
		ready = append(ready, "labels = "+jqlString(t.cfg.ReadyLabel))
	}
	cond := strings.Join(ready, " OR ")
	if len(ready) > 1 {
		cond = "(" + cond + ")"
	}
	return fmt.Sprintf("project = %s AND statusCategory != Done AND %s ORDER BY created ASC", jqlString(t.cfg.Project), cond)
}

// Ready lists open issues in the ready status or carrying the ready label, oldest first.
func (t *Tracker) Ready(ctx context.Context) ([]api.Ticket, error) {
	return t.search(ctx, t.readyJQL())
}

// activeStatuses are the status names mapped to a phase from claimed to merge-queue, sorted. A name
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

// Active lists open issues in a status mapped to a phase from claimed to merge-queue, oldest first,
// in one JQL search (Symphony §14). With no such status mapped it returns nothing and makes no request.
func (t *Tracker) Active(ctx context.Context) ([]api.Ticket, error) {
	names := t.activeStatuses()
	if len(names) == 0 {
		return nil, nil
	}
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = jqlString(n)
	}
	return t.search(ctx, fmt.Sprintf("project = %s AND statusCategory != Done AND status in (%s) ORDER BY created ASC",
		jqlString(t.cfg.Project), strings.Join(quoted, ", ")))
}

func (t *Tracker) search(ctx context.Context, jql string) ([]api.Ticket, error) {
	var out []api.Ticket
	token := ""
	for {
		req := map[string]any{"jql": jql, "fields": strings.Split(fields, ","), "maxResults": 100}
		if token != "" {
			req["nextPageToken"] = token
		}
		var page struct {
			Issues        []rawIssue `json:"issues"`
			NextPageToken string     `json:"nextPageToken"`
		}
		if err := t.call(ctx, http.MethodPost, "/rest/api/3/search/jql", nil, req, &page); err != nil {
			return nil, err
		}
		for _, i := range page.Issues {
			out = append(out, t.ticket(i))
		}
		if page.NextPageToken == "" {
			return out, nil
		}
		token = page.NextPageToken
	}
}

func (t *Tracker) issuePath(id api.TicketID) (string, error) {
	if !keyRe.MatchString(string(id)) || !strings.HasPrefix(string(id), t.cfg.Project+"-") {
		return "", fmt.Errorf("jira: %q is not an issue key of project %s", id, t.cfg.Project)
	}
	return "/rest/api/3/issue/" + string(id), nil
}

func (t *Tracker) raw(ctx context.Context, id api.TicketID, f string) (rawIssue, error) {
	p, err := t.issuePath(id)
	if err != nil {
		return rawIssue{}, err
	}
	var i rawIssue
	err = t.call(ctx, http.MethodGet, p, url.Values{"fields": {f}}, nil, &i)
	return i, err
}

// Get returns one issue by key, such as SHOP-42.
func (t *Tracker) Get(ctx context.Context, id api.TicketID) (api.Ticket, error) {
	i, err := t.raw(ctx, id, fields)
	if err != nil {
		return api.Ticket{}, err
	}
	return t.ticket(i), nil
}

// Comment adds a comment. Markers survive a renderer that drops HTML comments through a sealed footer.
func (t *Tracker) Comment(ctx context.Context, id api.TicketID, body string) error {
	p, err := t.issuePath(id)
	if err != nil {
		return err
	}
	tok, err := t.token()
	if err != nil {
		return err
	}
	text := vendorkit.EncodeBody(body, vendorkit.HMACSeal(tok), "comment")
	return t.call(ctx, http.MethodPost, p+"/comment", nil, map[string]any{"body": toADF(text)}, nil)
}

func (t *Tracker) owned(name string) bool {
	if name == t.cfg.ReadyStatus {
		return true
	}
	for _, s := range t.cfg.Phases {
		if s == name {
			return true
		}
	}
	return false
}

// SetPhase transitions the issue to the status mapped to p. A phase with no mapping is an error,
// and an issue sitting in a status the factory does not own is left alone.
func (t *Tracker) SetPhase(ctx context.Context, id api.TicketID, p api.Phase) error {
	target, ok := t.cfg.Phases[p]
	if !ok || target == "" {
		return fmt.Errorf("jira: no status mapped for phase %q", p)
	}
	cur, err := t.raw(ctx, id, "status")
	if err != nil {
		return err
	}
	if cur.Fields.Status.Name == target {
		return nil
	}
	if !t.owned(cur.Fields.Status.Name) {
		return fmt.Errorf("jira: %s is in status %q, which the factory does not own", id, cur.Fields.Status.Name)
	}
	path, _ := t.issuePath(id)
	var ts struct {
		Transitions []struct {
			ID string `json:"id"`
			To struct {
				Name string `json:"name"`
			} `json:"to"`
		} `json:"transitions"`
	}
	if err := t.call(ctx, http.MethodGet, path+"/transitions", nil, nil, &ts); err != nil {
		return err
	}
	for _, tr := range ts.Transitions {
		if tr.To.Name == target {
			return t.call(ctx, http.MethodPost, path+"/transitions", nil, map[string]any{"transition": map[string]any{"id": tr.ID}}, nil)
		}
	}
	return fmt.Errorf("jira: %s has no transition to status %q (mapped from phase %q)", id, target, p)
}

// spend finds the issue's spend comment: the one whose sealed footer holds and whose original
// carries the marker. It returns the issue path, the comment id and the original body.
func (t *Tracker) spend(ctx context.Context, id api.TicketID) (path, commentID, body string, err error) {
	if path, err = t.issuePath(id); err != nil {
		return "", "", "", err
	}
	tok, err := t.token()
	if err != nil {
		return "", "", "", err
	}
	var cs struct {
		Comments []struct {
			ID   string          `json:"id"`
			Body json.RawMessage `json:"body"`
		} `json:"comments"`
	}
	if err = t.call(ctx, http.MethodGet, path+"/comment", url.Values{"maxResults": {"1000"}}, nil, &cs); err != nil {
		return "", "", "", err
	}
	for _, c := range cs.Comments {
		if b, ok := vendorkit.DecodeBody(adfText(c.Body), vendorkit.HMACSeal(tok), "comment"); ok && strings.Contains(b, vendorkit.SpendMarker) {
			return path, c.ID, b, nil
		}
	}
	return path, "", "", nil
}

// SpendComment returns the spend ledger comment on the issue, or "" when none exists.
func (t *Tracker) SpendComment(ctx context.Context, id api.TicketID) (string, error) {
	_, _, b, err := t.spend(ctx, id)
	return b, err
}

// PutSpendComment updates the issue's spend ledger comment in place, or adds it the first time.
func (t *Tracker) PutSpendComment(ctx context.Context, id api.TicketID, body string) error {
	path, c, _, err := t.spend(ctx, id)
	if err != nil {
		return err
	}
	if c == "" {
		return t.Comment(ctx, id, body)
	}
	tok, _ := t.token()
	text := vendorkit.EncodeBody(body, vendorkit.HMACSeal(tok), "comment")
	return t.call(ctx, http.MethodPut, path+"/comment/"+c, nil, map[string]any{"body": toADF(text)}, nil)
}
