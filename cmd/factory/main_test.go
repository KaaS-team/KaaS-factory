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
