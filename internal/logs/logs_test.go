package logs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

func routinesSource(t *testing.T, h http.HandlerFunc) *Routines {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	r, err := NewRoutines(RoutinesConfig{BaseURL: srv.URL, Token: "tok-test", SessionID: "sess_1", HTTP: srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// Symphony §13 (observability): the run log is readable by an operator.
func TestRoutinesRunLogGolden(t *testing.T) {
	r := routinesSource(t, func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/v1/code/sessions/sess_1/events" || req.Header.Get("Authorization") != "Bearer tok-test" {
			http.Error(w, "bad request", 400)
			return
		}
		_, _ = w.Write([]byte(`{"data":[
{"id":"e1","time":"2026-11-12T10:00:00Z","kind":"start","text":"session started"},
{"id":"e2","time":"2026-11-12T10:00:05Z","kind":"tool","text":"ran go test\n./..."}],"next":"e2","status":"running"}`))
	})
	var out bytes.Buffer
	if err := Print(context.Background(), &out, r, Options{}); err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/routines.golden.txt")
	if err != nil {
		t.Fatal(err)
	}
	if out.String() != string(want) {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
}

func TestJSONOutput(t *testing.T) {
	src := fakeSource{pages: []Page{{Events: []Event{{ID: "a", Time: time.Unix(0, 0), Kind: "k", Text: "t"}}, Done: true}}}
	var out bytes.Buffer
	if err := Print(context.Background(), &out, &src, Options{JSON: true}); err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["kind"] != "k" || got["text"] != "t" || got["time"] != "1970-01-01T00:00:00Z" {
		t.Fatalf("got %v", got)
	}
}

type fakeSource struct {
	pages   []Page
	cursors []string
}

func (f *fakeSource) Poll(_ context.Context, c string) (Page, error) {
	f.cursors = append(f.cursors, c)
	i := len(f.cursors) - 1
	if i >= len(f.pages) {
		i = len(f.pages) - 1
	}
	return f.pages[i], nil
}

func ev(id string) Event { return Event{ID: id, Time: time.Unix(0, 0), Kind: "k", Text: id} }

func TestFollowOverlappingPagesPrintsOnce(t *testing.T) {
	var calls atomic.Int32
	r := routinesSource(t, func(w http.ResponseWriter, _ *http.Request) {
		pages := []string{
			`{"data":[{"id":"1","kind":"k","text":"one"},{"id":"2","kind":"k","text":"two"}],"next":"2","status":"running"}`,
			`{"data":[{"id":"2","kind":"k","text":"two"},{"id":"3","kind":"k","text":"three"}],"next":"3","status":"running"}`,
			`{"data":[{"id":"3","kind":"k","text":"three"},{"id":"4","kind":"k","text":"four"}],"next":"4","status":"completed"}`,
		}
		n := int(calls.Add(1))
		if n > len(pages) {
			http.Error(w, "polled after the run ended", 500)
			return
		}
		_, _ = w.Write([]byte(pages[n-1]))
	})
	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := Print(ctx, &out, r, Options{Follow: true, Interval: time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		texts = append(texts, l[strings.LastIndex(l, "  ")+2:])
	}
	if got := strings.Join(texts, ","); got != "one,two,three,four" {
		t.Fatalf("lines: %s", got)
	}
	if calls.Load() != 3 {
		t.Fatalf("polls: %d, want 3", calls.Load())
	}
}

func TestFollowStopsOnCancelAndNonFollowReturns(t *testing.T) {
	src := &fakeSource{pages: []Page{{Events: []Event{ev("1")}, Next: "1"}}}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	if err := Print(ctx, &bytes.Buffer{}, src, Options{Follow: true, Interval: time.Millisecond}); !errors.Is(err, context.Canceled) {
		t.Fatalf("follow: %v", err)
	}
	src = &fakeSource{pages: []Page{{Events: []Event{ev("1")}, Next: "1"}}}
	if err := Print(context.Background(), &bytes.Buffer{}, src, Options{}); err != nil || len(src.cursors) != 1 {
		t.Fatalf("non-follow: %v, polls %d", err, len(src.cursors))
	}
}

func TestNonFollowReadsEveryPage(t *testing.T) {
	src := &fakeSource{pages: []Page{{Events: []Event{ev("1")}, Next: "1", More: true}, {Events: []Event{ev("2")}, Next: "2"}}}
	var out bytes.Buffer
	if err := Print(context.Background(), &out, src, Options{}); err != nil {
		t.Fatal(err)
	}
	if strings.Count(out.String(), "\n") != 2 || strings.Join(src.cursors, "|") != "|1" {
		t.Fatalf("out %q cursors %v", out.String(), src.cursors)
	}
}

func TestRoutinesErrorsHideSecrets(t *testing.T) {
	r := routinesSource(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "secret-body tok-test", http.StatusUnauthorized)
	})
	_, err := r.Poll(context.Background(), "")
	if err == nil || strings.Contains(err.Error(), "tok-test") || strings.Contains(err.Error(), "secret-body") || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err %v", err)
	}
}

func TestRedact(t *testing.T) {
	for _, tc := range []struct{ name, in string }{
		{"github", "pushed with ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok"},
		{"github-pat", "github_pat_abcdefghijklmnopqrstuvwxyz"},
		{"anthropic", "key sk-ant-api03-abcdefghijklmnop"},
		{"bearer", "Authorization: Bearer abcdefgh12345678"},
		{"aws", "AKIAABCDEFGHIJKLMNOP"},
		{"slack", "xoxb-1234567890-abcdef"},
		{"jwt", "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl"},
		{"url-creds", "https://user:hunter2pass@example.com/x"},
		{"query", "https://x.test/?token=abc123&ok=1"},
		{"private-key", "-----BEGIN RSA PRIVATE KEY-----"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Redact(tc.in)
			if !strings.Contains(got, "[redacted]") {
				t.Fatalf("not redacted: %q", got)
			}
			for _, secret := range []string{"ghp_abc", "github_pat_abc", "sk-ant-api03", "abcdefgh12345678", "AKIAABC", "xoxb-1234", "eyJhbGci", "hunter2pass", "abc123", "PRIVATE KEY"} {
				if strings.Contains(got, secret) {
					t.Fatalf("leaked %q in %q", secret, got)
				}
			}
		})
	}
	if got := Redact("plain text, ok=1"); got != "plain text, ok=1" {
		t.Fatalf("changed: %q", got)
	}
}

func TestPrintRedactsBothFormats(t *testing.T) {
	e := Event{ID: "1", Time: time.Unix(0, 0), Kind: "k", Text: "token ghp_abcdefghijklmnopqrstuvwxyz0123"}
	for _, asJSON := range []bool{false, true} {
		var out bytes.Buffer
		if err := Print(context.Background(), &out, &fakeSource{pages: []Page{{Events: []Event{e}, Done: true}}}, Options{JSON: asJSON}); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(out.String(), "ghp_") || !strings.Contains(out.String(), "[redacted]") {
			t.Fatalf("json=%v: %q", asJSON, out.String())
		}
	}
}

type fakeResolver struct{ src Source }

func (f fakeResolver) Source(context.Context, api.TicketID) (Source, error) { return f.src, nil }

func TestCommandAndBackends(t *testing.T) {
	src := &fakeSource{pages: []Page{{Events: []Event{ev("1")}, Done: true}}}
	cmd := NewCommand(fakeResolver{src})
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"42", "-f", "--interval", "1ms"})
	if err := cmd.ExecuteContext(context.Background()); err != nil || !strings.Contains(out.String(), "  k  1") {
		t.Fatalf("err %v out %q", err, out.String())
	}

	b := Backends{
		Latest: func(context.Context, api.TicketID) (api.Session, error) {
			return api.Session{Dispatcher: "local", Attempt: 2}, nil
		},
		Factories: map[string]func(api.Session) (Source, error){
			"local": func(s api.Session) (Source, error) { return &fakeSource{}, nil },
		},
	}
	if got, err := b.Source(context.Background(), "1"); err != nil || got == nil {
		t.Fatalf("local: %v", err)
	}
	b.Latest = func(context.Context, api.TicketID) (api.Session, error) { return api.Session{Dispatcher: "other"}, nil }
	if _, err := b.Source(context.Background(), "1"); err == nil {
		t.Fatal("unknown dispatcher must fail")
	}
	b.Latest = func(context.Context, api.TicketID) (api.Session, error) { return api.Session{}, ErrNoSession }
	if _, err := b.Source(context.Background(), "1"); !errors.Is(err, ErrNoSession) {
		t.Fatalf("err %v", err)
	}
}
