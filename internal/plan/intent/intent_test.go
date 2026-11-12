package intent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/plan"
)

type fake struct {
	spec    Spec
	tickets []Draft
	specErr error
	calls   int
}

func (f *fake) Spec(_ context.Context, _ string) (Spec, error) { return f.spec, f.specErr }
func (f *fake) Tickets(_ context.Context, _ Spec) ([]Draft, error) {
	f.calls++
	return f.tickets, nil
}

const goodSpec = "# Resume\n\nAC-1: a build failure resumes at build\n"

func planned(deps, files string) string {
	h := plan.Marker + "\n"
	if deps != "" {
		h += "Deps: " + deps + "\n"
	}
	return h + "\n## Why\nx\n\n## Acceptance\n- AC-1: ok: checked by `t` (T1)\n\n## Files\n" + files
}

func TestRunAcceptsValidDraft(t *testing.T) {
	f := &fake{spec: Spec{Slug: "01-resume", Markdown: goodSpec}, tickets: []Draft{
		{Key: "t1", Title: "first", Body: planned("", "- `a.go`\n")},
		{Key: "t2", Title: "second", Body: planned("t1", "- `b.go`\n")},
	}}
	res, err := Run(context.Background(), f, "resume at the failed stage")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Plan.Tickets) != 2 || res.Plan.Tickets[1].Depends[0] != "t1" {
		t.Fatalf("tickets = %+v", res.Plan.Tickets)
	}
	for _, tk := range res.Plan.Tickets {
		if _, err := plan.ParseBody(tk.Body.Render()); err != nil {
			t.Errorf("%s does not parse as planned v1: %v", tk.ID, err)
		}
	}
	if len(res.Waves) != 2 {
		t.Errorf("waves = %v", res.Waves)
	}
}

func TestRunRejects(t *testing.T) {
	good := Spec{Slug: "01-resume", Markdown: goodSpec}
	cases := []struct {
		name    string
		f       *fake
		goal    string
		want    string
		tickets int
	}{
		{"empty goal", &fake{spec: good}, "  ", "the intent is empty", 0},
		{"bad slug", &fake{spec: Spec{Slug: "Resume", Markdown: goodSpec}}, "g", `slug "Resume" is not NN-words-with-dashes`, 0},
		{"no criteria", &fake{spec: Spec{Slug: "01-a", Markdown: "# x\n"}}, "g", "the spec has no acceptance criteria", 0},
		{"out of order", &fake{spec: Spec{Slug: "01-a", Markdown: "AC-2: x\n"}}, "g", "AC-2 is out of order: expected AC-1", 0},
		{"missing Files", &fake{spec: good, tickets: []Draft{{Key: "t1", Title: "a", Body: planned("", "")}}}, "g", "ticket t1 lists no Files.", 1},
		{"no marker", &fake{spec: good, tickets: []Draft{{Key: "t1", Title: "a", Body: "## Why\nx\n"}}}, "g", "ticket t1: The body does not start with", 1},
		{"cycle", &fake{spec: good, tickets: []Draft{
			{Key: "a", Title: "a", Body: planned("b", "- `a.go`\n")},
			{Key: "b", Title: "b", Body: planned("a", "- `b.go`\n")}}}, "g", "the blocking edges have a cycle: a -> b -> a", 1},
	}
	for _, c := range cases {
		_, err := Run(context.Background(), c.f, c.goal)
		var pe *ProblemsError
		if !errors.As(err, &pe) {
			t.Fatalf("%s: err = %v", c.name, err)
		}
		if !strings.Contains(strings.Join(pe.Problems, "\n"), c.want) {
			t.Errorf("%s: problems %q lack %q", c.name, pe.Problems, c.want)
		}
		if c.f.calls != c.tickets {
			t.Errorf("%s: tickets stage ran %d times, want %d", c.name, c.f.calls, c.tickets)
		}
	}
}

func TestRunPassesDrafterError(t *testing.T) {
	boom := errors.New("boom")
	_, err := Run(context.Background(), &fake{specErr: boom}, "g")
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}
