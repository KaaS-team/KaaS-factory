package main

import "testing"

// TestServe_Flags: serve exposes --addr (loopback by default) and --drain (30s by default).
func TestServe_Flags(t *testing.T) {
	c := newServe()
	if got := c.Flags().Lookup("addr").DefValue; got != "127.0.0.1:8787" {
		t.Fatalf("addr default %q", got)
	}
	if got := c.Flags().Lookup("drain").DefValue; got != "30s" {
		t.Fatalf("drain default %q", got)
	}
}
