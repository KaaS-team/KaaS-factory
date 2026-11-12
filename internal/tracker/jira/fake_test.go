package jira_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// Ported from tests/fixtures/trackers/jira-server.ts, moved to REST v3: bodies are Atlassian
// Document Format, and like a wiki renderer the fake drops HTML comments from stored text.
var (
	statuses = []struct{ Name, Category string }{
		{"To Do", "new"}, {"Ready", "new"}, {"In Progress", "indeterminate"}, {"In Review", "indeterminate"}, {"Done", "done"},
	}
	issuePath   = regexp.MustCompile(`^/rest/api/3/issue/([A-Z]+-\d+)(?:/(comment|transitions))?$`)
	statusJQL   = regexp.MustCompile(`status = "([^"]+)"`)
	labelJQL    = regexp.MustCompile(`labels = "([^"]+)"`)
	projectJQL  = regexp.MustCompile(`^project = "([^"]+)" AND statusCategory != Done`)
	commentMark = regexp.MustCompile(`(?s)<!--.*?-->`)
)

type fIssue struct {
	Key, Summary, Status string
	Description          any
	Labels               []string
	Comments             []map[string]any
}

type fakeJira struct {
	mu       sync.Mutex
	srv      *httptest.Server
	Token    string
	Issues   []*fIssue
	Requests []fakeReq
	Fail     []int // statuses to answer before serving normally
}

type fakeReq struct {
	Method, Path, Query, Auth string
	Body                      map[string]any
}

func newFakeJira(t *testing.T) *fakeJira {
	t.Helper()
	f := &fakeJira{Token: "me@example.com:test-token"}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func adf(lines ...string) map[string]any {
	content := []any{}
	for _, l := range lines {
		p := map[string]any{"type": "paragraph"}
		if l != "" {
			p["content"] = []any{map[string]any{"type": "text", "text": l}}
		}
		content = append(content, p)
	}
	return map[string]any{"type": "doc", "version": 1, "content": content}
}

func (f *fakeJira) add(n int, status string, labels ...string) *fIssue {
	i := &fIssue{Key: fmt.Sprintf("SHOP-%d", n), Summary: "Title", Status: status, Labels: labels, Description: adf("Body")}
	f.Issues = append(f.Issues, i)
	return i
}

func (f *fakeJira) find(key string) *fIssue {
	for _, i := range f.Issues {
		if i.Key == key {
			return i
		}
	}
	return nil
}

func category(status string) string {
	for _, s := range statuses {
		if s.Name == status {
			return s.Category
		}
	}
	return ""
}

func (f *fakeJira) view(i *fIssue) map[string]any {
	return map[string]any{"key": i.Key, "fields": map[string]any{
		"summary": i.Summary, "description": i.Description, "labels": i.Labels,
		"created": "2026-01-02T03:04:05.000+0000",
		"status":  map[string]any{"name": i.Status, "statusCategory": map[string]any{"key": category(i.Status)}},
	}}
}

func strip(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range x {
			if k == "text" {
				out[k] = commentMark.ReplaceAllString(val.(string), "")
			} else {
				out[k] = strip(val)
			}
		}
		return out
	case []any:
		out := []any{}
		for _, val := range x {
			out = append(out, strip(val))
		}
		return out
	}
	return v
}

func (f *fakeJira) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	f.Requests = append(f.Requests, fakeReq{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), body})
	if len(f.Fail) > 0 {
		code := f.Fail[0]
		f.Fail = f.Fail[1:]
		w.WriteHeader(code)
		return
	}
	if r.Header.Get("Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte(f.Token)) {
		w.WriteHeader(401)
		return
	}
	reply := func(status int, v any) {
		w.WriteHeader(status)
		if v != nil {
			_ = json.NewEncoder(w).Encode(v)
		}
	}
	if r.URL.Path == "/rest/api/3/search/jql" && r.Method == "POST" {
		jql := body["jql"].(string)
		m := projectJQL.FindStringSubmatch(jql)
		if m == nil {
			reply(400, map[string]any{"errorMessages": []string{"unsupported jql " + jql}})
			return
		}
		st, lb := statusJQL.FindStringSubmatch(jql), labelJQL.FindStringSubmatch(jql)
		or := strings.Contains(jql, " OR ")
		rows := []any{}
		for _, i := range f.Issues {
			if !strings.HasPrefix(i.Key, m[1]+"-") || category(i.Status) == "done" {
				continue
			}
			hasSt := st != nil && i.Status == st[1]
			hasLb := false
			if lb != nil {
				for _, l := range i.Labels {
					hasLb = hasLb || l == lb[1]
				}
			}
			ok := (st == nil || hasSt) && (lb == nil || hasLb)
			if or {
				ok = hasSt || hasLb
			}
			if ok {
				rows = append(rows, f.view(i))
			}
		}
		reply(200, map[string]any{"issues": rows, "isLast": true})
		return
	}
	m := issuePath.FindStringSubmatch(r.URL.Path)
	var i *fIssue
	if m != nil {
		i = f.find(m[1])
	}
	if i == nil {
		reply(404, map[string]any{"errorMessages": []string{"Issue does not exist"}})
		return
	}
	switch {
	case m[2] == "" && r.Method == "GET":
		reply(200, f.view(i))
	case m[2] == "transitions" && r.Method == "GET":
		ts := []any{}
		for n, s := range statuses {
			if s.Name != i.Status {
				ts = append(ts, map[string]any{"id": fmt.Sprint(n + 11), "name": s.Name, "to": map[string]any{"name": s.Name, "statusCategory": map[string]any{"key": s.Category}}})
			}
		}
		reply(200, map[string]any{"transitions": ts})
	case m[2] == "transitions" && r.Method == "POST":
		var n int
		_, _ = fmt.Sscan(body["transition"].(map[string]any)["id"].(string), &n)
		if n < 11 || n-11 >= len(statuses) {
			reply(400, map[string]any{"errorMessages": []string{"bad transition"}})
			return
		}
		i.Status = statuses[n-11].Name
		reply(204, nil)
	case m[2] == "comment" && r.Method == "POST":
		c := map[string]any{"id": fmt.Sprint(10000 + len(i.Comments)), "body": strip(body["body"])}
		i.Comments = append(i.Comments, c)
		reply(201, map[string]any{"id": c["id"]})
	default:
		reply(404, map[string]any{"errorMessages": []string{"not found"}})
	}
}

func (f *fakeJira) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.Requests {
		out = append(out, r.Method+" "+r.Path)
	}
	return out
}
