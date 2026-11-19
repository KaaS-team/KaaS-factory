package tui

import (
	"context"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api/porttest"
)

func TestCommandWithoutControlFails(t *testing.T) {
	c := NewCommand()
	if c.Use != "board" {
		t.Fatalf("Use = %q", c.Use)
	}
	c.SetContext(context.Background())
	c.SetArgs(nil)
	if err := c.Execute(); err == nil || !strings.Contains(err.Error(), "no control") {
		t.Fatalf("err = %v", err)
	}
}

func TestCommandRunsAndQuits(t *testing.T) {
	f := porttest.NewControl(fixedBoard())
	c := NewCommand()
	c.SetContext(WithControl(context.Background(), f))
	c.SetIn(strings.NewReader("q"))
	var out strings.Builder
	c.SetOut(&out)
	c.SetArgs(nil)
	if err := c.Execute(); err != nil {
		t.Fatal(err)
	}
}

func TestCommandReplayRunsAndQuits(t *testing.T) {
	c := NewCommand()
	c.SetContext(context.Background())
	c.SetIn(strings.NewReader("q"))
	var out strings.Builder
	c.SetOut(&out)
	c.SetArgs([]string{"--replay", "../../docs/demo/fleet.ndjson", "--speed", "1000"})
	if err := c.Execute(); err != nil {
		t.Fatal(err)
	}
	c.SetArgs([]string{"--replay", "missing.ndjson"})
	if err := c.Execute(); err == nil {
		t.Fatal("a missing replay file must fail")
	}
}
