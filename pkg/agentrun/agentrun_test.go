package agentrun_test

import (
	"context"
	"go/ast"
	"go/doc"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/pkg/agentrun"
)

type dirWorktrees struct{ dir string }

func (d dirWorktrees) Add(context.Context, agentrun.Brief) (string, error) { return d.dir, nil }

// Compile-time check: NewLocal's result satisfies Dispatcher.
var _ func(context.Context, agentrun.LocalConfig) (agentrun.Dispatcher, error) = agentrun.NewLocal

func TestLocalBriefRunsToCompletionAndMeterReadsUsage(t *testing.T) {
	bin := t.TempDir()
	script := `#!/bin/sh
echo '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5}}}'
echo '{"type":"result","usage":{"input_tokens":12,"output_tokens":6,"cache_read_input_tokens":2,"cache_creation_input_tokens":1},"total_cost_usd":0.25}'
`
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH")) // exec resolves argv[0] from the parent PATH
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d, err := agentrun.NewLocal(ctx, agentrun.LocalConfig{
		Worktrees: dirWorktrees{t.TempDir()},
		Environ:   []string{"PATH=" + os.Getenv("PATH")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.Name() != "local" || d.Caps().Remote {
		t.Errorf("name %q caps %+v", d.Name(), d.Caps())
	}
	s, err := d.Dispatch(ctx, agentrun.Brief{Ticket: "7", Attempt: 1, Name: "v9-7-a1.md", Repo: "o/r", Base: "main", Branch: "factory/7-a1", Text: "x"})
	if err != nil {
		t.Fatal(err)
	}
	w, ok := d.(interface {
		Wait(context.Context, agentrun.Session) error
	})
	if !ok {
		t.Fatal("the local dispatcher has no Wait")
	}
	if err := w.Wait(ctx, s); err != nil { // returns once the output is fully read
		t.Fatal(err)
	}
	u, err := d.Usage(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	if u.InputTokens != 12 || u.OutputTokens != 6 || u.CacheReadTokens != 2 || u.CacheWriteTokens != 1 || u.CostUSD != 0.25 {
		t.Fatalf("usage %+v", u)
	}
	m := agentrun.NewMeter(agentrun.Budgets{}, time.Now)
	k := agentrun.MeterKey{Team: "t", Ticket: s.Ticket, Session: s.Key}
	if _, err := m.Record(k, u); err != nil {
		t.Fatal(err)
	}
	if got := m.Used(k).Ticket.InputTokens; got != 12 {
		t.Errorf("meter ticket input tokens %d", got)
	}
}

func TestNewRoutinesForwardsConfigChecks(t *testing.T) {
	if _, err := agentrun.NewRoutines(agentrun.RoutinesConfig{}); err == nil {
		t.Error("want an error without base URL and token")
	}
	d, err := agentrun.NewRoutines(agentrun.RoutinesConfig{BaseURL: "http://127.0.0.1:1", Token: "x"})
	if err != nil || d.Name() != "routines" || !d.Caps().Remote {
		t.Errorf("got %v, %v", d, err)
	}
}

func TestEveryExportedIdentifierHasADocComment(t *testing.T) {
	fset := token.NewFileSet()
	names, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var files []*ast.File
	for _, n := range names {
		if strings.HasSuffix(n, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, n, nil, parser.ParseComments)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, f)
	}
	p, err := doc.NewFromFiles(fset, files, "github.com/KaaS-team/factory/pkg/agentrun", doc.AllDecls)
	if err != nil {
		t.Fatal(err)
	}
	if p.Doc == "" {
		t.Error("package has no doc comment")
	}
	check := func(kind, name, d string) {
		if ast.IsExported(name) && d == "" {
			t.Errorf("%s %s has no doc comment", kind, name)
		}
	}
	for _, ty := range p.Types {
		check("type", ty.Name, ty.Doc)
		for _, f := range ty.Funcs {
			check("func", f.Name, f.Doc)
		}
		for _, m := range ty.Methods {
			check("method", ty.Name+"."+m.Name, m.Doc)
		}
	}
	for _, f := range p.Funcs {
		check("func", f.Name, f.Doc)
	}
	for _, vs := range append(p.Vars, p.Consts...) {
		for _, n := range vs.Names {
			check("value", n, vs.Doc)
		}
	}
}
