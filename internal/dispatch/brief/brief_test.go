package brief

import (
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

func TestName(t *testing.T) {
	rows := []struct {
		ticket  api.TicketID
		attempt int
		want    string
		bad     bool
	}{
		{"123", 1, "v9-123-a1.md", false},
		{"ENG-42", 3, "v9-ENG-42-a3.md", false},
		{"a.b_c", 1, "v9-a.b_c-a1.md", false},
		{"", 1, "", true},
		{"1/2", 1, "", true},
		{"../x", 1, "", true},
		{"a b", 1, "", true},
		{"7", 0, "", true},
		{"7", -1, "", true},
	}
	for _, r := range rows {
		got, err := Name(r.ticket, r.attempt)
		if (err != nil) != r.bad || got != r.want {
			t.Errorf("Name(%q,%d) = %q, %v", r.ticket, r.attempt, got, err)
		}
	}
}

func TestRenderGolden(t *testing.T) {
	b := api.Brief{
		Ticket: "7", Attempt: 2, Repo: "o/r", Base: "main", Branch: "factory/7-a2",
		Text: "Add the thing.\n\nAC: it works.", Workflow: "build", Node: "impl",
		Model: "some-model", Budget: api.Budget{Tokens: 5000, USD: 3},
	}
	want := "# Ticket 7, attempt 2\n\n" +
		"- Repo: o/r\n- Base: main\n- Branch: factory/7-a2\n- Workflow: build\n- Node: impl\n\n" +
		"Start with `git fetch origin && git checkout -b factory/7-a2 origin/main`, " +
		"commit on that branch and push it. Do not push to main.\n\n" +
		"Add the thing.\n\nAC: it works.\n"
	got, err := Render(b)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
	// Model and budget are the operator's; the brief lives in the repo.
	for _, s := range []string{"some-model", "5000", "USD"} {
		if strings.Contains(got, s) {
			t.Errorf("brief leaks %q", s)
		}
	}
}

func TestRenderOmitsEmptyFieldsAndKeepsOneTrailingNewline(t *testing.T) {
	got, err := Render(api.Brief{Ticket: "9", Attempt: 1, Repo: "o/r", Base: "main", Branch: "factory/9-a1", Text: "x\n\n\n"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "Workflow") || strings.Contains(got, "Node") {
		t.Errorf("empty fields rendered:\n%s", got)
	}
	if !strings.HasSuffix(got, "x\n") || strings.HasSuffix(got, "\n\n") {
		t.Errorf("trailing newlines: %q", got[len(got)-6:])
	}
}

func TestRenderRefusesWhatCannotBeRun(t *testing.T) {
	ok := api.Brief{Ticket: "9", Attempt: 1, Repo: "o/r", Base: "main", Branch: "factory/9-a1", Text: "x"}
	for name, mut := range map[string]func(*api.Brief){
		"bad ticket":      func(b *api.Brief) { b.Ticket = "a/b" },
		"no branch":       func(b *api.Brief) { b.Branch = "" },
		"no base":         func(b *api.Brief) { b.Base = "" },
		"no repo":         func(b *api.Brief) { b.Repo = "" },
		"no text":         func(b *api.Brief) { b.Text = "  \n" },
		"shell in branch": func(b *api.Brief) { b.Branch = "x; rm -rf /" },
		"shell in base":   func(b *api.Brief) { b.Base = "main`id`" },
		"option as base":  func(b *api.Brief) { b.Base = "--orphan" },
	} {
		b := ok
		mut(&b)
		if _, err := Render(b); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestPrompt(t *testing.T) {
	want := "Run `git fetch origin cloud-briefs && git show origin/cloud-briefs:v9-7-a1.md`, then follow that brief exactly."
	if got := Prompt("v9-7-a1.md"); got != want {
		t.Errorf("got %q", got)
	}
}
