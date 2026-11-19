package firstrun

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api/porttest"
)

// TestCommandFixOpensDraftPR pins the --fix path: report, then dispatch, then the PR line and scorecard.
func TestCommandFixOpensDraftPR(t *testing.T) {
	fakeAuditor(t)
	prs := &fakePRs{}
	c := NewCommand(WithExec(func(context.Context) (Exec, error) {
		return Exec{Dispatcher: porttest.NewDispatcher(1), PRs: prs, Repo: "o/r", Base: "main"}, nil
	}))
	var out bytes.Buffer
	c.SetOut(&out)
	c.SetArgs([]string{"--fix"})
	if err := c.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "## Top 3 risks") || !strings.Contains(out.String(), "Draft pull request #7 opened.") || len(prs.calls) != 1 {
		t.Fatalf("calls=%d out:\n%s", len(prs.calls), out.String())
	}
}

// TestCommandFlagsWithExec pins which flags exist: --fix only with an Exec builder.
func TestCommandFlagsWithExec(t *testing.T) {
	if NewCommand().Flags().Lookup("fix") != nil {
		t.Error("--fix without WithExec")
	}
	c := NewCommand(WithExec(func(context.Context) (Exec, error) { return Exec{}, nil }))
	for _, f := range []string{"fix", "dry-run", "gh", "annotations", "sarif"} {
		if c.Flags().Lookup(f) == nil {
			t.Errorf("missing --%s", f)
		}
	}
}
