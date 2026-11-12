package smoke

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeHub is a stateful fake of the GitHub REST endpoints the loop touches, backed by a local bare
// git repository, so pushes by the fake agent and by the merge queue are real.
type fakeHub struct {
	t     *testing.T
	bare  string // path of the bare repo
	owner string
	repo  string

	mu       sync.Mutex
	clock    time.Time
	issues   []*fhIssue
	prs      []*fhPR
	requests []string
}

type fhIssue struct {
	n        int
	title    string
	body     string
	state    string
	labels   []string
	created  time.Time
	timeline []fhEvent
	comments []fhComment
}

type fhEvent struct {
	label string
	at    time.Time
}

type fhComment struct {
	id   int
	body string
	at   time.Time
}

type fhPR struct {
	n      int
	head   string
	base   string
	title  string
	closed bool
}

func newFakeHub(t *testing.T, bare string) (*fakeHub, *httptest.Server) {
	t.Helper()
	h := &fakeHub{t: t, bare: bare, owner: "acme", repo: "sandbox", clock: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return h, srv
}

func (h *fakeHub) tick() time.Time {
	h.clock = h.clock.Add(time.Second)
	return h.clock
}

func (h *fakeHub) git(args ...string) (string, int) {
	cmd := exec.Command("git", args...)
	cmd.Dir = h.bare
	out, err := cmd.Output()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		h.t.Errorf("fake hub: git %v: %v", args, err)
		code = -1
	}
	return strings.TrimSpace(string(out)), code
}

func (h *fakeHub) sawRequest(method, path string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.requests {
		if r == method+" "+path {
			return true
		}
	}
	return false
}

func (h *fakeHub) issue(n int) *fhIssue {
	for _, is := range h.issues {
		if is.n == n {
			return is
		}
	}
	return nil
}

func (is *fhIssue) has(label string) bool {
	for _, l := range is.labels {
		if l == label {
			return true
		}
	}
	return false
}

func (h *fakeHub) issueJSON(is *fhIssue) map[string]any {
	labels := []map[string]any{}
	for _, l := range is.labels {
		labels = append(labels, map[string]any{"name": l})
	}
	return map[string]any{"number": is.n, "title": is.title, "body": is.body, "state": is.state, "labels": labels, "created_at": is.created.Format(time.RFC3339)}
}

func (h *fakeHub) prJSON(p *fhPR) map[string]any {
	head, _ := h.git("rev-parse", "--verify", "-q", "refs/heads/"+p.head)
	base, _ := h.git("rev-parse", "--verify", "-q", "refs/heads/"+p.base)
	_, code := h.git("merge-base", "--is-ancestor", head, base)
	merged := head != "" && code == 0
	state := "open"
	if merged || p.closed {
		state = "closed"
	}
	return map[string]any{"number": p.n, "state": state, "merged": merged, "title": p.title,
		"head": map[string]any{"ref": p.head, "sha": head}, "base": map[string]any{"ref": p.base}}
}

func decode(r *http.Request, v any) {
	_ = json.NewDecoder(r.Body).Decode(v)
}

func (h *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.requests = append(h.requests, r.Method+" "+r.URL.Path)
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	notFound := func() { w.WriteHeader(http.StatusNotFound); _, _ = w.Write([]byte(`{"message":"Not Found"}`)) }
	if r.URL.Path == "/user" {
		_ = enc.Encode(map[string]any{"login": "factory-bot"})
		return
	}
	prefix := "/repos/" + h.owner + "/" + h.repo + "/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		notFound()
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, prefix)
	m := r.Method
	switch {
	case m == "POST" && rest == "issues":
		var in struct {
			Title  string   `json:"title"`
			Body   string   `json:"body"`
			Labels []string `json:"labels"`
		}
		decode(r, &in)
		is := &fhIssue{n: len(h.issues) + 1, title: in.Title, body: in.Body, state: "open", created: h.tick()}
		for _, l := range in.Labels {
			is.labels = append(is.labels, l)
			is.timeline = append(is.timeline, fhEvent{l, h.tick()})
		}
		h.issues = append(h.issues, is)
		w.WriteHeader(http.StatusCreated)
		_ = enc.Encode(h.issueJSON(is))
	case m == "GET" && rest == "issues":
		label, state := r.URL.Query().Get("labels"), r.URL.Query().Get("state")
		out := []map[string]any{}
		for _, is := range h.issues {
			if (state == "open" && is.state != "open") || (label != "" && !is.has(label)) {
				continue
			}
			out = append(out, h.issueJSON(is))
		}
		_ = enc.Encode(out)
	case strings.HasPrefix(rest, "issues/"):
		h.serveIssue(w, r, strings.Split(strings.TrimPrefix(rest, "issues/"), "/"))
	case m == "GET" && strings.HasPrefix(rest, "branches/"):
		name := strings.TrimPrefix(rest, "branches/")
		sha, _ := h.git("rev-parse", "--verify", "-q", "refs/heads/"+name)
		if sha == "" {
			notFound()
			return
		}
		date, _ := h.git("log", "-1", "--format=%cI", sha)
		_ = enc.Encode(map[string]any{"name": name, "commit": map[string]any{"sha": sha, "commit": map[string]any{"committer": map[string]any{"date": date}}}})
	case m == "GET" && rest == "pulls":
		head := strings.TrimPrefix(r.URL.Query().Get("head"), h.owner+":")
		out := []map[string]any{}
		for i := len(h.prs) - 1; i >= 0; i-- {
			if h.prs[i].head == head {
				out = append(out, h.prJSON(h.prs[i]))
			}
		}
		_ = enc.Encode(out)
	case m == "POST" && rest == "pulls":
		var in struct{ Title, Head, Base string }
		decode(r, &in)
		if sha, _ := h.git("rev-parse", "--verify", "-q", "refs/heads/"+in.Head); sha == "" {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"head branch does not exist"}`))
			return
		}
		p := &fhPR{n: len(h.prs) + 1, head: in.Head, base: in.Base, title: in.Title}
		h.prs = append(h.prs, p)
		w.WriteHeader(http.StatusCreated)
		_ = enc.Encode(h.prJSON(p))
	case strings.HasPrefix(rest, "pulls/"):
		n, _ := strconv.Atoi(strings.TrimPrefix(rest, "pulls/"))
		if n < 1 || n > len(h.prs) {
			notFound()
			return
		}
		if m == "PATCH" {
			var in struct{ State string }
			decode(r, &in)
			h.prs[n-1].closed = in.State == "closed"
		}
		_ = enc.Encode(h.prJSON(h.prs[n-1]))
	case m == "GET" && strings.HasPrefix(rest, "compare/"):
		spec := strings.TrimPrefix(rest, "compare/")
		base, head, _ := strings.Cut(spec, "...")
		out, _ := h.git("diff", "--name-only", "refs/heads/"+base+"...refs/heads/"+head)
		files := []map[string]any{}
		for _, f := range strings.Fields(out) {
			files = append(files, map[string]any{"filename": f})
		}
		_ = enc.Encode(map[string]any{"files": files})
	case m == "GET" && strings.HasSuffix(rest, "/check-runs"):
		_ = enc.Encode(map[string]any{"total_count": 0, "check_runs": []any{}})
	case m == "GET" && strings.HasSuffix(rest, "/status"):
		_ = enc.Encode(map[string]any{"state": "pending", "statuses": []any{}})
	case m == "GET" && strings.HasPrefix(rest, "contents/"):
		ref := r.URL.Query().Get("ref")
		path := strings.TrimPrefix(rest, "contents/")
		out, code := h.git("show", "refs/heads/"+ref+":"+path)
		if code != 0 {
			notFound()
			return
		}
		_ = enc.Encode(map[string]any{"type": "file", "name": path, "path": path, "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(out))})
	case m == "DELETE" && strings.HasPrefix(rest, "git/refs/"):
		ref := "refs/" + strings.TrimPrefix(rest, "git/refs/")
		if _, code := h.git("update-ref", "-d", ref); code != 0 {
			w.WriteHeader(http.StatusUnprocessableEntity)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		h.t.Errorf("fake hub: unhandled %s %s", m, r.URL.Path)
		w.WriteHeader(http.StatusTeapot)
	}
}

func (h *fakeHub) serveIssue(w http.ResponseWriter, r *http.Request, p []string) {
	enc := json.NewEncoder(w)
	n, _ := strconv.Atoi(p[0])
	is := h.issue(n)
	if is == nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		return
	}
	switch {
	case len(p) == 1 && r.Method == "GET":
		_ = enc.Encode(h.issueJSON(is))
	case len(p) == 1 && r.Method == "PATCH":
		var in struct{ State string }
		decode(r, &in)
		if in.State != "" {
			is.state = in.State
		}
		_ = enc.Encode(h.issueJSON(is))
	case len(p) == 2 && p[1] == "comments" && r.Method == "POST":
		var in struct{ Body string }
		decode(r, &in)
		c := fhComment{id: len(is.comments) + 1, body: in.Body, at: h.tick()}
		is.comments = append(is.comments, c)
		w.WriteHeader(http.StatusCreated)
		_ = enc.Encode(map[string]any{"id": c.id, "body": c.body, "created_at": c.at.Format(time.RFC3339), "user": map[string]any{"login": "factory-bot"}})
	case len(p) == 2 && p[1] == "comments" && r.Method == "GET":
		out := []map[string]any{}
		for _, c := range is.comments {
			out = append(out, map[string]any{"id": c.id, "body": c.body, "created_at": c.at.Format(time.RFC3339), "user": map[string]any{"login": "factory-bot"}})
		}
		_ = enc.Encode(out)
	case len(p) == 2 && p[1] == "labels" && r.Method == "POST":
		var labels []string
		decode(r, &labels)
		for _, l := range labels {
			if !is.has(l) {
				is.labels = append(is.labels, l)
				is.timeline = append(is.timeline, fhEvent{l, h.tick()})
			}
		}
		_ = enc.Encode([]any{})
	case len(p) == 3 && p[1] == "labels" && r.Method == "DELETE":
		var keep []string
		for _, l := range is.labels {
			if l != p[2] {
				keep = append(keep, l)
			}
		}
		is.labels = keep
		_ = enc.Encode([]any{})
	case len(p) == 2 && p[1] == "timeline" && r.Method == "GET":
		out := []map[string]any{}
		for _, e := range is.timeline {
			out = append(out, map[string]any{"event": "labeled", "label": map[string]any{"name": e.label}, "created_at": e.at.Format(time.RFC3339)})
		}
		_ = enc.Encode(out)
	default:
		h.t.Errorf("fake hub: unhandled %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusTeapot)
	}
}
