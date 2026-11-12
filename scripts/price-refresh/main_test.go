package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fake(body string, err error) func(context.Context, string) ([]byte, error) {
	return func(_ context.Context, sha string) ([]byte, error) {
		if sha != "abc1234" {
			return nil, errors.New("wrong sha " + sha)
		}
		return []byte(body), err
	}
}

const tier = `"pricingTiers":[{"id":"s","name":"Standard","isDefault":true,"priority":0,"conditions":[],"prices":{"input":1e-06}}]`

func TestRunReportsNewUpstreamModel(t *testing.T) {
	var out bytes.Buffer
	err := run(context.Background(), []string{"-sha", "abc1234"}, &out, fake(`[{"modelName":"claude-brand-new-9","matchPattern":"^claude-brand-new-9$",`+tier+`}]`, nil))
	if !errors.Is(err, errDiffers) {
		t.Fatalf("err = %v, want errDiffers", err)
	}
	if !strings.Contains(out.String(), "claude-brand-new-9") || !strings.Contains(out.String(), "abc1234") {
		t.Fatalf("report:\n%s", out.String())
	}
}

func TestRunFromFileAndFetchError(t *testing.T) {
	p := filepath.Join(t.TempDir(), "up.json")
	if err := os.WriteFile(p, []byte(`[]`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	// Every embedded model is "removed" against an empty upstream: the report lists them.
	if err := run(context.Background(), []string{"-upstream", p}, &out, nil); !errors.Is(err, errDiffers) {
		t.Fatalf("err = %v", err)
	}
	if err := run(context.Background(), []string{"-sha", "abc1234"}, &out, fake("", errors.New("offline"))); err == nil || errors.Is(err, errDiffers) {
		t.Fatalf("fetch error not surfaced: %v", err)
	}
}
