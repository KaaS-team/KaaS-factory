package plancmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

// fakeFiler is an in-memory Filer; Symphony §11 keeps the tracker the system of record.
type fakeFiler struct {
	filed []api.Ticket
}

func (f *fakeFiler) Find(_ context.Context, title string) (api.TicketID, bool, error) {
	for i, t := range f.filed {
		if t.Title == title {
			return api.TicketID(fmt.Sprint(i + 1)), true, nil
		}
	}
	return "", false, nil
}

func (f *fakeFiler) Create(_ context.Context, t api.Ticket) (api.TicketID, error) {
	f.filed = append(f.filed, t)
	return api.TicketID(fmt.Sprint(len(f.filed))), nil
}

func run(t *testing.T, f Filer, args ...string) (string, error) {
	t.Helper()
	opts := []Option{WithSpecFunc(func(context.Context, string) (string, error) { return mustRead(t, "testdata/spec5.md"), nil })}
	if f != nil {
		opts = append(opts, WithFiler(f))
	}
	c := NewCommand(opts...)
	var out bytes.Buffer
	c.SetOut(&out)
	c.SetErr(&out)
	c.SetArgs(args)
	err := c.ExecuteContext(context.Background())
	return out.String(), err
}

func mustRead(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestPlanPrintsWavesGolden(t *testing.T) {
	out, err := run(t, nil, "--spec", "testdata/spec5.md")
	if err != nil {
		t.Fatal(err)
	}
	if want := mustRead(t, "testdata/waves.golden"); out != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out, want)
	}
}

func TestPlanGoalUsesInjectedSpec(t *testing.T) {
	out, err := run(t, nil, "ship it")
	if err != nil || !strings.Contains(out, "Wave 3:") {
		t.Fatalf("err=%v out=%s", err, out)
	}
}

func TestPlanDefaultSpecAsksForSpecFlag(t *testing.T) {
	c := NewCommand()
	c.SetArgs([]string{"ship it"})
	c.SetOut(&bytes.Buffer{})
	c.SetErr(&bytes.Buffer{})
	err := c.ExecuteContext(context.Background())
	if err == nil || !strings.Contains(err.Error(), "--spec") {
		t.Fatalf("err=%v", err)
	}
}

func TestPlanProblemsListedAndApproveRefuses(t *testing.T) {
	for _, tc := range []struct{ file, want string }{
		{"testdata/loop.md", "cycle"},
		{"testdata/dup.md", "duplicates the title"},
	} {
		t.Run(tc.file, func(t *testing.T) {
			f := &fakeFiler{}
			out, err := run(t, f, "--spec", tc.file)
			if err != nil || !strings.Contains(out, "Problems:") || !strings.Contains(out, tc.want) {
				t.Fatalf("err=%v out=%s", err, out)
			}
			_, err = run(t, f, "--spec", tc.file, "--approve")
			if err == nil || len(f.filed) != 0 {
				t.Fatalf("approve err=%v filed=%d", err, len(f.filed))
			}
		})
	}
}

func TestPlanWithoutApproveWritesNothing(t *testing.T) {
	f := &fakeFiler{}
	if _, err := run(t, f, "--spec", "testdata/spec5.md"); err != nil || len(f.filed) != 0 {
		t.Fatalf("err=%v filed=%d", err, len(f.filed))
	}
}

func TestApproveFilesOnceIdempotent(t *testing.T) {
	f := &fakeFiler{}
	if _, err := run(t, f, "--spec", "testdata/spec5.md", "--approve"); err != nil {
		t.Fatal(err)
	}
	if len(f.filed) != 5 {
		t.Fatalf("filed %d", len(f.filed))
	}
	t4 := f.filed[3]
	for _, want := range []string{"Files: internal/d/d.go", "Blocked by: #1, #2"} {
		if !strings.Contains(t4.Body, want) {
			t.Errorf("body lacks %q:\n%s", want, t4.Body)
		}
	}
	if len(t4.BlockedBy) != 2 || len(t4.Files) != 1 {
		t.Errorf("fields: %+v", t4)
	}
	if _, err := run(t, f, "--spec", "testdata/spec5.md", "--approve"); err != nil {
		t.Fatal(err)
	}
	if len(f.filed) != 5 {
		t.Fatalf("second approve filed %d", len(f.filed))
	}
}

func TestApproveNeedsFiler(t *testing.T) {
	if _, err := run(t, nil, "--spec", "testdata/spec5.md", "--approve"); err == nil {
		t.Fatal("want error without a filer")
	}
}

type errFiler struct{ fakeFiler }

func (*errFiler) Create(context.Context, api.Ticket) (api.TicketID, error) {
	return "", errors.New("boom")
}

func TestApproveCreateErrorSurfaces(t *testing.T) {
	if _, err := run(t, &errFiler{}, "--spec", "testdata/spec5.md", "--approve"); err == nil {
		t.Fatal("want error")
	}
}

func TestJSONDecodesIntoDAG(t *testing.T) {
	out, err := run(t, nil, "--spec", "testdata/spec5.md", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var d DAG
	if err := json.Unmarshal([]byte(out), &d); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if len(d.Tickets) != 5 || len(d.Waves) != 3 || len(d.Problems) != 0 || d.Tickets[3].Depends[1] != "T2" {
		t.Fatalf("%+v", d)
	}
}

func TestEpicReadsIssueBody(t *testing.T) {
	c := NewCommand(WithEpic(func(_ context.Context, n int) (string, error) {
		if n != 7 {
			t.Fatalf("n=%d", n)
		}
		return mustRead(t, "testdata/spec5.md"), nil
	}))
	var out bytes.Buffer
	c.SetOut(&out)
	c.SetArgs([]string{"--epic", "7"})
	if err := c.ExecuteContext(context.Background()); err != nil || !strings.Contains(out.String(), "Wave 1:") {
		t.Fatalf("err=%v out=%s", err, out.String())
	}
}

func TestPlanNeedsExactlyOneSource(t *testing.T) {
	for _, args := range [][]string{{}, {"g", "--spec", "testdata/spec5.md"}} {
		if _, err := run(t, nil, args...); err == nil {
			t.Errorf("%v: want error", args)
		}
	}
}

func TestSlugOf(t *testing.T) {
	for in, want := range map[string]string{
		"a/02-resume.md": "02-resume",
		"spec5.md":       "01-spec5",
		"My Spec.md":     "01-my-spec",
		"---.md":         "01-spec",
	} {
		if got := slugOf(in); got != want {
			t.Errorf("%s: %q want %q", in, got, want)
		}
	}
}

func TestSpecWithoutTicketsIsProblem(t *testing.T) {
	c := NewCommand(WithSpecFunc(func(context.Context, string) (string, error) { return "AC-1: x\n", nil }))
	var out bytes.Buffer
	c.SetOut(&out)
	c.SetArgs([]string{"g"})
	if err := c.ExecuteContext(context.Background()); err != nil || !strings.Contains(out.String(), "there are no tickets") {
		t.Fatalf("err=%v out=%s", err, out.String())
	}
}
