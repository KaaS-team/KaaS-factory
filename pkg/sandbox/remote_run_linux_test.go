package sandbox

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeBoxes is a remote sandbox service: create, exec (one stdout line and an exit status) and destroy.
func fakeBoxes(t *testing.T, exit int, destroyed *atomic.Int32) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /sandboxes", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "b1"})
	})
	mux.HandleFunc("POST /sandboxes/b1/exec", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Argv []string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"stream": "stdout", "data": "ran " + strings.Join(body.Argv, " ") + "\n"})
		_ = json.NewEncoder(w).Encode(map[string]any{"exit": exit})
	})
	mux.HandleFunc("DELETE /sandboxes/b1", func(http.ResponseWriter, *http.Request) { destroyed.Add(1) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

// Backend "remote" runs the command in a box on the service, streams its output and destroys the box.
func TestCommandRemoteRunsInABox(t *testing.T) {
	var destroyed atomic.Int32
	t.Setenv("FACTORY_SANDBOX_URL", fakeBoxes(t, 0, &destroyed))
	t.Setenv("FACTORY_SANDBOX_TOKEN", "tok")
	cmd, err := Command(t.Context(), Spec{Backend: BackendRemote, Workdir: "/work"}, "agent", "--go")
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if out.String() != "ran agent --go\n" || destroyed.Load() != 1 {
		t.Fatalf("out %q destroyed %d", out.String(), destroyed.Load())
	}
}

func TestCommandRemoteKeepsExitStatus(t *testing.T) {
	var destroyed atomic.Int32
	t.Setenv("FACTORY_SANDBOX_URL", fakeBoxes(t, 3, &destroyed))
	t.Setenv("FACTORY_SANDBOX_TOKEN", "tok")
	cmd, err := Command(t.Context(), Spec{Backend: BackendRemote}, "agent")
	if err != nil {
		t.Fatal(err)
	}
	err = cmd.Run()
	if cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 3 || err == nil {
		t.Fatalf("err %v state %v", err, cmd.ProcessState)
	}
}
