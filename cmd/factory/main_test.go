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
