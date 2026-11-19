package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/KaaS-team/factory/pkg/sandbox"
)

var _ sandbox.Session = (*Client)(nil)

// fake is an in-memory remote sandbox API.
type fake struct {
	mu        sync.Mutex
	files     map[string][]byte
	live      map[string]bool
	destroyed int
	exit      int
}

func (f *fake) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		switch {
		case r.Method == "POST" && len(parts) == 1:
			f.live["box1"] = true
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "box1"})
		case r.Method == "POST" && len(parts) == 3 && parts[2] == "exec":
			_, _ = io.WriteString(w, `{"stream":"stdout","data":"hello "}`+"\n"+`{"stream":"stderr","data":"warn"}`+"\n"+`{"stream":"stdout","data":"world"}`+"\n")
			_ = json.NewEncoder(w).Encode(map[string]int{"exit": f.exit})
		case r.Method == "PUT" && len(parts) == 3:
			b, _ := io.ReadAll(r.Body)
			f.files[r.URL.Query().Get("path")] = b
		case r.Method == "GET" && len(parts) == 3:
			b, ok := f.files[r.URL.Query().Get("path")]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(b)
		case r.Method == "DELETE" && len(parts) == 2:
			delete(f.live, parts[1])
			f.destroyed++
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL)
			http.NotFound(w, r)
		}
	})
}

func newFake(t *testing.T) (*fake, *Client) {
	f := &fake{files: map[string][]byte{}, live: map[string]bool{}}
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	c, err := New(srv.URL, "tok", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	return f, c
}

func create(c *Client) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) { return c.Create(ctx, CreateSpec{Workdir: "/work"}) }
}

func TestFullCycle(t *testing.T) {
	f, c := newFake(t)
	var out, errOut bytes.Buffer
	var got bytes.Buffer
	err := sandbox.RunRemote(t.Context(), create(c), c, func(id string) error {
		if err := c.CopyIn(t.Context(), id, "/work/in.txt", strings.NewReader("payload")); err != nil {
			return err
		}
		if err := c.Exec(t.Context(), id, []string{"echo"}, &out, &errOut); err != nil {
			return err
		}
		return c.CopyOut(t.Context(), id, "/work/in.txt", &got)
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.String() != "hello world" || errOut.String() != "warn" {
		t.Fatalf("stdout %q stderr %q", out.String(), errOut.String())
	}
	if got.String() != "payload" {
		t.Fatalf("copy out %q", got.String())
	}
	if f.destroyed != 1 || len(f.live) != 0 {
		t.Fatalf("destroyed=%d live=%v", f.destroyed, f.live)
	}
}

func TestDestroyWhenExecFails(t *testing.T) {
	f, c := newFake(t)
	f.exit = 3
	err := sandbox.RunRemote(t.Context(), create(c), c, func(id string) error {
		return c.Exec(t.Context(), id, []string{"false"}, io.Discard, io.Discard)
	})
	var ee *ExitError
	if !asExit(err, &ee) || ee.Code != 3 {
		t.Fatalf("want exit 3, got %v", err)
	}
	if f.destroyed != 1 {
		t.Fatalf("destroy calls = %d, want 1", f.destroyed)
	}
}

func TestDestroyWhenContextCancelled(t *testing.T) {
	f, c := newFake(t)
	ctx, cancel := context.WithCancel(t.Context())
	_ = sandbox.RunRemote(ctx, create(c), c, func(id string) error {
		cancel()
		return c.Exec(ctx, id, []string{"x"}, io.Discard, io.Discard)
	})
	if f.destroyed != 1 {
		t.Fatalf("destroy calls = %d, want 1", f.destroyed)
	}
}

func TestBadTokenAndEnv(t *testing.T) {
	_, c := newFake(t)
	c.token = "wrong"
	if _, err := c.Create(t.Context(), CreateSpec{}); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("want 401, got %v", err)
	}
	t.Setenv(EnvURL, "")
	if _, err := FromEnv(); err == nil {
		t.Fatal("want error for missing url")
	}
	t.Setenv(EnvURL, "http://x")
	t.Setenv(EnvToken, "")
	if _, err := FromEnv(); err == nil {
		t.Fatal("want error for missing token")
	}
	t.Setenv(EnvToken, "t")
	if _, err := FromEnv(); err != nil {
		t.Fatal(err)
	}
}

func TestStreamWithoutExitIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"stream":"stdout","data":"x"}`+"\n")
	}))
	defer srv.Close()
	c, _ := New(srv.URL, "t", nil)
	if err := c.Exec(t.Context(), "b", []string{"x"}, io.Discard, io.Discard); err == nil {
		t.Fatal("want error")
	}
}

func asExit(err error, target **ExitError) bool { return errors.As(err, target) }
