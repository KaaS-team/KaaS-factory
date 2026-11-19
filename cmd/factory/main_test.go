package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestVersionPrints(t *testing.T) {
	var out bytes.Buffer
	root := newRoot()
	root.SetOut(&out)
	root.SetArgs([]string{"version"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != version {
		t.Fatalf("got %q want %q", out.String(), version)
	}
}

// TestShadowCommandIsMounted: `factory shadow` reads the shadow log and is part of the binary.
func TestShadowCommandIsMounted(t *testing.T) {
	var out bytes.Buffer
	root := newRoot()
	root.SetOut(&out)
	root.SetArgs([]string{"shadow", "--file", t.TempDir() + "/none"})
	if err := root.Execute(); err != nil || !strings.Contains(out.String(), "no shadow records") {
		t.Fatalf("err %v out %q", err, out.String())
	}
}

// TestVersionFlagPrintsVersionCommitAndDate: `factory --version` shows what goreleaser injects.
func TestVersionFlagPrintsVersionCommitAndDate(t *testing.T) {
	oldV, oldC, oldD := version, commit, date
	t.Cleanup(func() { version, commit, date = oldV, oldC, oldD })
	version, commit, date = "9.0.0", "abc1234", "2026-11-19T00:00:00Z"
	var out bytes.Buffer
	root := newRoot()
	root.SetOut(&out)
	root.SetArgs([]string{"--version"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	want := "factory 9.0.0 (commit abc1234, built 2026-11-19T00:00:00Z)"
	if strings.TrimSpace(out.String()) != want {
		t.Fatalf("got %q want %q", out.String(), want)
	}
}
