package linear_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync"
	"testing"
)

// Ported from tests/fixtures/trackers/linear-server.ts: the same named operations and response
// shapes, with the marker stripping Linear's editor may do.
var (
	opRe      = regexp.MustCompile(`^\s*(?:query|mutation)\s+(\w+)`)
	commentRe = regexp.MustCompile(`(?s)<!--.*?-->`)
)

type fState struct{ ID, Name, Type string }

type fIssue struct {
	ID, Title, Description, State string // State is a state id
	Number                        int
	Labels                        []string
	Comments                      []map[string]any
}

type fakeLinear struct {
	mu       sync.Mutex
	srv      *httptest.Server
	Token    string
	States   []fState
	Issues   []*fIssue
	Requests []fakeReq
	// Fail, if set, answers the next requests with these statuses before serving normally.
	Fail []int
}

type fakeReq struct {
	Op   string
	Body map[string]any
	Auth string
}

func newFakeLinear(t *testing.T) *fakeLinear {
	t.Helper()
	f := &fakeLinear{Token: "test-token", States: []fState{
		{"s-backlog", "Backlog", "backlog"}, {"s-ready", "Ready", "unstarted"},
		{"s-progress", "In Progress", "started"}, {"s-review", "In Review", "started"},
		{"s-done", "Done", "completed"}, {"s-cancel", "Canceled", "canceled"},
	}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeLinear) add(number int, state string, labels ...string) *fIssue {
	i := &fIssue{ID: "uuid-" + itoa(len(f.Issues)+1), Title: "Title", Description: "Body", Number: number, State: state, Labels: labels}
	f.Issues = append(f.Issues, i)
	return i
}

func (f *fakeLinear) find(id string) *fIssue {
	for _, i := range f.Issues {
		if i.ID == id || "ENG-"+itoa(i.Number) == id {
			return i
		}
	}
	return nil
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func (f *fakeLinear) stateOf(id string) fState {
	for _, s := range f.States {
		if s.ID == id {
			return s
		}
	}
	return fState{}
}

func (f *fakeLinear) view(i *fIssue) map[string]any {
	labels := []any{}
	for _, l := range i.Labels {
		labels = append(labels, map[string]any{"id": "lbl-" + l, "name": l, "updatedAt": "2026-01-01T00:00:00Z"})
	}
	comments := []any{}
	for _, c := range i.Comments {
		comments = append(comments, c)
	}
	return map[string]any{
		"id": i.ID, "number": i.Number, "title": i.Title, "description": i.Description,
		"state":   map[string]any{"type": f.stateOf(i.State).Type, "name": f.stateOf(i.State).Name, "id": i.State},
		"creator": map[string]any{"id": "u1"}, "createdAt": "2026-01-02T03:04:05.000Z",
		"labels": map[string]any{"nodes": labels}, "comments": map[string]any{"nodes": comments},
	}
}

func (f *fakeLinear) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	raw, _ := io.ReadAll(r.Body)
	var req struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	_ = json.Unmarshal(raw, &req)
	op := ""
	if m := opRe.FindStringSubmatch(req.Query); m != nil {
		op = m[1]
	}
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	f.Requests = append(f.Requests, fakeReq{op, body, r.Header.Get("Authorization")})
	if len(f.Fail) > 0 {
		code := f.Fail[0]
		f.Fail = f.Fail[1:]
		w.WriteHeader(code)
		return
	}
	if r.Header.Get("Authorization") != f.Token {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"errors":[{"message":"Authentication required"}]}`))
		return
	}
	data, err := f.run(op, req.Variables)
	if err != "" {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": nil, "errors": []any{map[string]any{"message": err}}})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
}

func (f *fakeLinear) run(op string, v map[string]any) (any, string) {
	switch op {
	case "Issue":
		if i := f.find(v["id"].(string)); i != nil {
			return map[string]any{"issue": f.view(i)}, ""
		}
		return map[string]any{"issue": nil}, ""
	case "IssueState":
		i := f.find(v["id"].(string))
		if i == nil {
			return map[string]any{"issue": nil}, ""
		}
		s := f.stateOf(i.State)
		return map[string]any{"issue": map[string]any{"id": i.ID, "state": map[string]any{"id": s.ID, "name": s.Name}}}, ""
	case "Team":
		nodes := []any{}
		for _, s := range f.States {
			nodes = append(nodes, map[string]any{"id": s.ID, "name": s.Name, "type": s.Type, "position": len(nodes)})
		}
		return map[string]any{"teams": map[string]any{"nodes": []any{map[string]any{"id": "team-1", "states": map[string]any{"nodes": nodes}}}}}, ""
	case "Issues":
		return f.issues(v["filter"].(map[string]any)), ""
	case "CommentCreate":
		in := v["input"].(map[string]any)
		i := f.find(in["issueId"].(string))
		if i == nil {
			return nil, "Entity not found: Issue"
		}
		id := "c-" + itoa(len(i.Comments)+1)
		i.Comments = append(i.Comments, map[string]any{"id": id, "body": commentRe.ReplaceAllString(in["body"].(string), ""), "createdAt": "2026-01-02T03:04:05.000Z", "user": map[string]any{"id": "bot"}})
		return map[string]any{"commentCreate": map[string]any{"comment": map[string]any{"id": id}}}, ""
	case "IssueUpdate":
		i := f.find(v["id"].(string))
		if i == nil {
			return nil, "Entity not found: Issue"
		}
		if s, ok := v["input"].(map[string]any)["stateId"].(string); ok {
			i.State = s
		}
		return map[string]any{"issueUpdate": map[string]any{"success": true}}, ""
	}
	return nil, "unknown operation " + op
}

// issues answers Issues the way the TS fixture does: team, state type and label filters, plus
// the state name and "or" shapes the Go adapter adds.
func (f *fakeLinear) issues(filter map[string]any) any {
	match := func(i *fIssue, flt map[string]any) bool {
		st := f.stateOf(i.State)
		if s, ok := flt["state"].(map[string]any); ok {
			if t, ok := s["type"].(map[string]any); ok {
				for _, x := range t["nin"].([]any) {
					if x == st.Type {
						return false
					}
				}
			}
			if n, ok := s["name"].(map[string]any); ok && n["eq"] != st.Name {
				return false
			}
		}
		if l, ok := flt["labels"].(map[string]any); ok {
			found := false
			for _, x := range i.Labels {
				found = found || x == l["name"].(map[string]any)["eq"]
			}
			if !found {
				return false
			}
		}
		return true
	}
	nodes := []any{}
	for _, i := range f.Issues {
		ok := match(i, filter)
		if or, has := filter["or"].([]any); has {
			ok = false
			for _, alt := range or {
				ok = ok || match(i, alt.(map[string]any))
			}
		}
		if ok {
			nodes = append(nodes, f.view(i))
		}
	}
	return map[string]any{"issues": map[string]any{"nodes": nodes, "pageInfo": map[string]any{"hasNextPage": false, "endCursor": nil}}}
}

func (f *fakeLinear) ops() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.Requests {
		out = append(out, r.Op)
	}
	return out
}
