package astgrep

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadPackExample(t *testing.T) {
	p, err := LoadPack("testdata/example-pack")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Rules) != 3 {
		t.Fatalf("want 3 rules, got %d", len(p.Rules))
	}
	r := p.Rules[0]
	if r.ID != "no-console-log" || r.Language != "TypeScript" || r.Severity != SeverityError || r.Message == "" {
		t.Fatalf("rule %+v", r)
	}
}

func TestLoadPackRejects(t *testing.T) {
	cases := []struct{ name, body string }{
		{"missing id", "language: TypeScript\nrule:\n  pattern: x\n"},
		{"missing language", "id: a\nrule:\n  pattern: x\n"},
		{"missing rule", "id: a\nlanguage: TypeScript\n"},
		{"bad severity", "id: a\nlanguage: TypeScript\nseverity: loud\nrule:\n  pattern: x\n"},
		{"unknown field", "id: a\nlanguage: TypeScript\nbogus: 1\nrule:\n  pattern: x\n"},
		{"not yaml", ": : :\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.MkdirAll(filepath.Join(dir, "rules"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "rules", "a.yml"), []byte(c.body), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadPack(dir); err == nil {
				t.Fatal("want an error")
			}
		})
	}
	if _, err := LoadPack(t.TempDir()); err == nil {
		t.Fatal("a directory with no rules is not a pack")
	}
}

func TestSeverityPolicy(t *testing.T) {
	cases := []struct {
		s    Severity
		want Policy
	}{
		{SeverityError, PolicyBlock},
		{SeverityWarning, PolicyWarn},
		{SeverityInfo, PolicyNote},
		{SeverityHint, PolicyNote},
		{SeverityOff, PolicyIgnore},
		{"", PolicyNote}, // ast-grep's default severity is hint
	}
	for _, c := range cases {
		if got := c.s.Policy(); got != c.want {
			t.Errorf("%q: %v, want %v", c.s, got, c.want)
		}
	}
}

const testOut = "Running 3 tests\nPASS no-console-log  ..\nFAIL no-var  .N\nSKIP no-todo  \n\ntest failed. 1 passed; 1 failed;\n"

func TestEvalScorecard(t *testing.T) {
	p, err := LoadPack("testdata/example-pack")
	if err != nil {
		t.Fatal(err)
	}
	r := &fakeRunner{out: testOut, exit: 1}
	sc, err := Eval(context.Background(), r, "testdata/example-pack", p)
	if err != nil {
		t.Fatal(err)
	}
	if sc.Passed != 1 || sc.Total != 3 || sc.String() != "rules passed 1/3" {
		t.Fatalf("scorecard %+v %s", sc, sc)
	}
	if len(sc.Failed) != 2 || sc.Failed[0] != "no-todo" || sc.Failed[1] != "no-var" {
		t.Fatalf("failed %v", sc.Failed)
	}
	if got := sc.Rate(); got < 0.33 || got > 0.34 {
		t.Fatalf("rate %v", got)
	}
	if r.gotArgs[0] != "test" {
		t.Fatalf("argv %q", r.gotArgs)
	}
}

func TestEvalErrors(t *testing.T) {
	p, _ := LoadPack("testdata/example-pack")
	if _, err := Eval(context.Background(), &fakeRunner{errOut: "Error: bad", exit: 2}, ".", p); err == nil {
		t.Fatal("a load failure must not score as zero")
	} else if le := new(*RuleLoadError); !errors.As(err, le) {
		t.Fatalf("want RuleLoadError, got %T", err)
	}
	if sc, err := Eval(context.Background(), &fakeRunner{out: "PASS no-console-log  .\n"}, ".", p); err != nil || sc.Passed != 1 || sc.Total != 3 {
		t.Fatalf("rules absent from the output count as failed: %+v %v", sc, err)
	}
}

func TestGateBlocksOnErrorFindings(t *testing.T) {
	fs := []Finding{{Severity: SeverityWarning}, {Severity: SeverityHint}}
	if g := Gate(fs); g.Block || g.Warn != 1 || g.Note != 1 {
		t.Fatalf("%+v", g)
	}
	fs = append(fs, Finding{Severity: SeverityError})
	if g := Gate(fs); !g.Block {
		t.Fatalf("%+v", g)
	}
}
