package design

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/graph"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/pkg/sandbox"
)

// fakeRunner returns a canned reply; the pack itself is covered by packs/design/test.
type fakeRunner struct {
	out   string
	exit  int
	err   error
	args  []string
	stdin string
}

func (f *fakeRunner) Run(_ context.Context, _ string, stdin []byte, args ...string) ([]byte, int, error) {
	f.args, f.stdin = args, string(stdin)
	return []byte(f.out), f.exit, f.err
}

func TestStepOutcomes(t *testing.T) {
	cases := []struct {
		name      string
		r         *fakeRunner
		wantDet   bool
		wantAgent int
		wantFiles int
		wantWhy   string
		wantErr   bool
	}{
		{"applied", &fakeRunner{out: `{"applied":["App.tsx"]}`}, true, 0, 1, "", false},
		{"dynamic falls back", &fakeRunner{out: `{"error":"dynamic","oid":"cond","message":"m"}`, exit: 2}, false, 1, 0, "dynamic", false},
		{"missing oid falls back", &fakeRunner{out: `{"error":"missing-oid","oid":"zz"}`, exit: 2}, false, 1, 0, "missing-oid", false},
		{"layout change falls back", &fakeRunner{out: `{"error":"unsupported-kind"}`, exit: 2}, false, 1, 0, "unsupported-kind", false},
		{"usage error is an error, not a fallback", &fakeRunner{out: `{"error":"usage"}`, exit: 1}, false, 0, 0, "", true},
		{"runner failure is an error", &fakeRunner{err: errors.New("no node")}, false, 0, 0, "", true},
		{"garbage fallback output is an error", &fakeRunner{out: `nope`, exit: 2}, false, 0, 0, "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			agents := 0
			o, err := Step(context.Background(), c.r, t.TempDir(), "delta.json", func(context.Context) error { agents++; return nil })
			if (err != nil) != c.wantErr {
				t.Fatalf("err = %v", err)
			}
			if o.Deterministic != c.wantDet || agents != c.wantAgent || len(o.Files) != c.wantFiles || o.Reason != c.wantWhy {
				t.Fatalf("outcome %+v agents %d", o, agents)
			}
		})
	}
}

func TestStepFallbackReturnsAgentError(t *testing.T) {
	want := errors.New("agent failed")
	_, err := Step(context.Background(), &fakeRunner{out: `{"error":"dynamic"}`, exit: 2}, t.TempDir(), "d.json", func(context.Context) error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("err = %v", err)
	}
}

func TestApplyEditsPassesRequestAndStripFlag(t *testing.T) {
	f := &fakeRunner{out: `{"original":"a","generated":"b","path":"App.tsx"}`}
	txt := "Bye"
	d, err := ApplyEdits(context.Background(), f, "dir", "App.tsx", []Request{{OID: "h", TextContent: &txt}}, true)
	if err != nil || d.Generated != "b" || d.Original != "a" {
		t.Fatalf("%+v %v", d, err)
	}
	if strings.Join(f.args, " ") != "apply-edits --strip-ids" || !strings.Contains(f.stdin, `"file":"App.tsx"`) || !strings.Contains(f.stdin, `"textContent":"Bye"`) {
		t.Fatalf("args %v stdin %s", f.args, f.stdin)
	}
	if _, err = ApplyEdits(context.Background(), f, "dir", "App.tsx", nil, false); err != nil || strings.Join(f.args, " ") != "apply-edits" {
		t.Fatalf("args %v err %v", f.args, err)
	}
}

func TestApplyEditsFallbackIsTyped(t *testing.T) {
	f := &fakeRunner{out: `{"error":"dynamic","oid":"cond","message":"m"}`, exit: 2}
	_, err := ApplyEdits(context.Background(), f, "dir", "App.tsx", nil, false)
	var fb *Fallback
	if !errors.As(err, &fb) || fb.Code != "dynamic" || fb.OID != "cond" {
		t.Fatalf("err = %v", err)
	}
}

func TestStamp(t *testing.T) {
	f := &fakeRunner{out: `{"stamped":["a.tsx"]}`}
	got, err := Stamp(context.Background(), f, "dir")
	if err != nil || len(got) != 1 || f.args[0] != "oid-stamp" {
		t.Fatalf("%v %v %v", got, err, f.args)
	}
}

// pack returns the real pack when node and its dependencies are installed, and skips otherwise.
func pack(t *testing.T) NodeRunner {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	p, _ := filepath.Abs("../../packs/design")
	if _, err := os.Stat(filepath.Join(p, "node_modules", "@babel", "standalone")); err != nil {
		t.Skip("run npm ci in packs/design")
	}
	return NodeRunner{Pack: p}
}

func tree(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	src, err := os.ReadFile("testdata/App.tsx")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "App.tsx"), src, 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// TestFixtureTweaksUseNoAgent is the eval fixture set: simple tweaks take the deterministic path
// and the meter records nothing; dynamic and unsupported ones call the agent once.
func TestFixtureTweaksUseNoAgent(t *testing.T) {
	r := pack(t)
	if sandbox.Probe().Landlock {
		r.Jail = true
	}
	fixtures := []struct {
		name, delta string
		det         bool
		reason      string
	}{
		{"style", `{"changes":[{"file":"App.tsx","oid":"root","kind":"style","className":"p-4"}]}`, true, ""},
		{"text", `{"changes":[{"file":"App.tsx","oid":"h","kind":"text","text":"Bye"}]}`, true, ""},
		{"move", `{"changes":[{"file":"App.tsx","kind":"move","oid":"e","parent":"root","index":0}]}`, true, ""},
		{"remove", `{"changes":[{"file":"App.tsx","oid":"p","kind":"remove"}]}`, true, ""},
		{"conditional node", `{"changes":[{"file":"App.tsx","oid":"cond","kind":"text","text":"y"}]}`, false, "dynamic"},
		{"array node", `{"changes":[{"file":"App.tsx","oid":"item","kind":"style","className":"a"}]}`, false, "dynamic"},
		{"missing oid", `{"changes":[{"file":"App.tsx","oid":"nope","kind":"text","text":"y"}]}`, false, "missing-oid"},
		{"layout", `{"changes":[{"file":"App.tsx","oid":"root","kind":"group"}]}`, false, "unsupported-kind"},
	}
	m := meter.New(meter.Budgets{}, time.Now)
	key := meter.Key{Team: "t", Ticket: api.TicketID("T-1"), Node: "tweak", Session: "s"}
	for _, f := range fixtures {
		t.Run(f.name, func(t *testing.T) {
			dir := tree(t)
			if err := os.WriteFile(filepath.Join(dir, "delta.json"), []byte(f.delta), 0o644); err != nil {
				t.Fatal(err)
			}
			agents := 0
			o, err := Step(context.Background(), r, dir, "delta.json", func(context.Context) error { agents++; return nil })
			if err != nil {
				t.Fatal(err)
			}
			if o.Deterministic != f.det || o.Reason != f.reason || (agents == 0) != f.det {
				t.Fatalf("outcome %+v agents %d", o, agents)
			}
			got, _ := os.ReadFile(filepath.Join(dir, "App.tsx"))
			orig, _ := os.ReadFile("testdata/App.tsx")
			if (string(got) != string(orig)) != f.det {
				t.Fatalf("file changed = %v, want %v", string(got) != string(orig), f.det)
			}
			if f.det {
				if u := m.Used(key); u.Node != (api.Usage{}) || u.Ticket != (api.Usage{}) {
					t.Fatalf("meter recorded usage on the deterministic path: %+v", u)
				}
			}
		})
	}
}

func TestRealApplyEditsStripsIDsAndStamps(t *testing.T) {
	r := pack(t)
	dir := tree(t)
	txt := "Bye"
	d, err := ApplyEdits(context.Background(), r, dir, "App.tsx", []Request{{OID: "h", TextContent: &txt}}, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d.Generated, "Bye") || strings.Contains(d.Generated, "data-oid") {
		t.Fatalf("generated:\n%s", d.Generated)
	}
	if err := os.WriteFile(filepath.Join(dir, "B.tsx"), []byte("<div><b/></div>"), 0o644); err != nil {
		t.Fatal(err)
	}
	files, err := Stamp(context.Background(), r, dir)
	if err != nil || len(files) != 1 {
		t.Fatalf("stamped %v err %v", files, err)
	}
	_, err = ApplyEdits(context.Background(), r, dir, "App.tsx", []Request{{OID: "cond", TextContent: &txt}}, false)
	var fb *Fallback
	if !errors.As(err, &fb) || fb.Code != "dynamic" {
		t.Fatalf("err = %v", err)
	}
}

func TestJailedRunStamps(t *testing.T) {
	r := pack(t)
	if !sandbox.Probe().Landlock {
		t.Skip("no landlock on this host")
	}
	r.Jail = true
	out, code, err := r.Run(context.Background(), t.TempDir(), nil, "oid-stamp", ".")
	if err != nil || code != 0 || !strings.Contains(string(out), "stamped") {
		t.Fatalf("out %s code %d err %v", out, code, err)
	}
}

// TestDesignToPRWorkflow keeps the tweak step wired: triage reaches it, a pass skips every agent
// step to the PR, and a fallback goes to the design step.
func TestDesignToPRWorkflow(t *testing.T) {
	g, err := graph.Load("../../packs/workflows/design-to-pr.yml")
	if err != nil {
		t.Fatal(err)
	}
	tw, ok := g.Node("tweak")
	if !ok || tw.Uses != "check" || !strings.Contains(tw.Run, "packs/design/bin/design.js tweak") {
		t.Fatalf("tweak node = %+v", tw)
	}
	for _, c := range []struct {
		from string
		on   graph.Outcome
		want string
	}{
		{"triage", graph.Pass, "tweak"},
		{"tweak", graph.Pass, "pr"},
		{"tweak", graph.Fail, "design"},
	} {
		if got, err := g.Next(c.from, c.on); err != nil || got != c.want {
			t.Errorf("%s on %s -> %q, %v; want %q", c.from, c.on, got, err, c.want)
		}
	}
}
