package browsercheck

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/gate"
)

const page = `<!doctype html><title>t</title><body><h1>Hello</h1>
<input id="name"><button id="go" onclick="document.getElementById('out').textContent='Hi '+document.getElementById('name').value">go</button>
<p id="out"></p>
<script>if (location.search.indexOf('err') >= 0) console.error('boom')</script></body>`

// latePage renders the answer of a request the server holds for 250 ms, the way a fetch-then-render page does.
const latePage = `<!doctype html><title>t</title><body><button id="go" onclick="fetch('/data').then(r=>r.text()).then(t=>{document.getElementById('out').textContent=t})">go</button><p id="out"></p></body>`

func server(t *testing.T) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		if r.URL.Path == "/data" {
			time.Sleep(250 * time.Millisecond)
			_, _ = fmt.Fprint(w, "Done late")
			return
		}
		if r.URL.Path == "/late" {
			_, _ = fmt.Fprint(w, latePage)
			return
		}
		_, _ = fmt.Fprint(w, page)
	}))
	t.Cleanup(s.Close)
	return s
}

func chromePath(t *testing.T) string {
	t.Helper()
	p, err := LookChrome(exec.LookPath)
	if err != nil {
		t.Skipf("no Chrome in this session: %v", err)
	}
	return p
}

func runSteps(t *testing.T, yamlText string) (Result, string) {
	t.Helper()
	steps, err := ParseSteps([]byte(yamlText))
	if err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return Run(ctx, Options{Steps: steps, OutDir: out, Look: func(string) (string, error) { return chromePath(t), nil }}), out
}

func TestRunAgainstPage(t *testing.T) {
	srv := server(t)
	tests := []struct {
		name       string
		steps      string
		wantStatus string
		wantMsg    string
	}{
		{"pass", fmt.Sprintf("- goto: %s/\n- fill: {selector: '#name', value: Ada}\n- click: '#go'\n- expect_text: Hi Ada\n- expect_no_console_error: true\n- screenshot: home\n", srv.URL), "GREEN", ""},
		{"missing text", fmt.Sprintf("- goto: %s/\n- expect_text: nowhere to be found\n", srv.URL), "RED", "expect_text"},
		{"console error", fmt.Sprintf("- goto: %s/?err\n- expect_no_console_error: true\n", srv.URL), "RED", "console error"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, out := runSteps(t, tt.steps)
			parsed, ok := gate.Parse(res.Line())
			if !ok {
				t.Fatalf("line does not parse: %q", res.Line())
			}
			if parsed.Status != tt.wantStatus {
				t.Fatalf("status = %s (%s), want %s", parsed.Status, res.Message, tt.wantStatus)
			}
			if !strings.Contains(res.Message, tt.wantMsg) {
				t.Errorf("message %q lacks %q", res.Message, tt.wantMsg)
			}
			if tt.name == "pass" {
				if _, err := os.Stat(filepath.Join(out, "home.png")); err != nil {
					t.Error(err)
				}
			}
		})
	}
}

// TestSettleReplacesFixedSleep: expect_text right after a click sees a render that waits on a 250 ms request.
func TestSettleReplacesFixedSleep(t *testing.T) {
	srv := server(t)
	res, _ := runSteps(t, fmt.Sprintf("- goto: %s/late\n- click: '#go'\n- expect_text: Done late\n", srv.URL))
	if res.Failed > 0 {
		t.Fatalf("step after click did not wait for the page: %s", res.Message)
	}
}

// TestNoFixedSleeps keeps time.Sleep out of the check: waits are events with a cap.
func TestNoFixedSleeps(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, _ := os.ReadFile(f)
		if strings.Contains(string(b), "time.Sleep") {
			t.Errorf("%s uses time.Sleep", f)
		}
	}
}

func TestRunNoChrome(t *testing.T) {
	steps := []Step{{Kind: "goto", URL: "http://127.0.0.1:1/"}}
	res := Run(context.Background(), Options{Steps: steps, OutDir: t.TempDir(), Look: func(string) (string, error) { return "", errors.New("nope") }})
	if res.Message != "browser: chrome not found" {
		t.Errorf("message = %q", res.Message)
	}
	parsed, ok := gate.Parse(res.Line())
	if !ok || parsed.Status != "RED" || parsed.Green() || parsed.Failed != 1 || strings.Join(parsed.FailedGates, ",") != "browser" {
		t.Errorf("line %q parsed %+v", res.Line(), parsed)
	}
}
