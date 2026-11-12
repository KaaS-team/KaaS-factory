package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheck(t *testing.T) {
	base := Baseline{GoLines: 100, Deadcode: 10, Reason: "start"}
	tests := []struct {
		name    string
		cur     Counts
		wantErr string
	}{
		{"below", Counts{GoLines: 90, Deadcode: 5}, ""},
		{"equal", Counts{GoLines: 100, Deadcode: 10}, ""},
		{"lines above", Counts{GoLines: 101, Deadcode: 10}, "go_lines 101 is above baseline 100"},
		{"deadcode above", Counts{GoLines: 100, Deadcode: 11}, "deadcode 11 is above baseline 10"},
		{"both above", Counts{GoLines: 101, Deadcode: 11}, "go_lines 101"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := Check(base, tc.cur)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error %v, want containing %q", err, tc.wantErr)
			}
		})
	}
}

func TestLower(t *testing.T) {
	base := Baseline{GoLines: 100, Deadcode: 10, Reason: "keep"}
	tests := []struct {
		name string
		cur  Counts
		want Baseline
	}{
		{"below lowers both", Counts{90, 5}, Baseline{90, 5, "keep"}},
		{"equal unchanged", Counts{100, 10}, base},
		{"above never raises", Counts{150, 20}, base},
		{"mixed lowers only the lower", Counts{90, 20}, Baseline{90, 10, "keep"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Lower(base, tc.cur); got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestCountGoLines(t *testing.T) {
	files := map[string]string{
		"a.go":            "a\nb\n",
		"a_test.go":       "x\nx\nx\n",
		"src/b.go":        "frozen\n",
		"pkg/c.go":        "one\ntwo\nthree",
		"tools/d.go":      "\n",
		"README.md":       "ignored\n",
		"srcother/e.go":   "x\n",
		"pkg/sub_test.go": "t\n",
	}
	dir := t.TempDir()
	var names []string
	for n, c := range files {
		p := filepath.Join(dir, n)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	got, err := CountGoLines(dir, names)
	if err != nil {
		t.Fatal(err)
	}
	// a.go 2, pkg/c.go 3 (no trailing newline), tools/d.go 1, srcother/e.go 1.
	if got != 7 {
		t.Fatalf("got %d, want 7", got)
	}
}

func TestCountDeadcode(t *testing.T) {
	if got := CountDeadcode("a: x\n\nb: y\n"); got != 2 {
		t.Fatalf("got %d, want 2", got)
	}
	if got := CountDeadcode(""); got != 0 {
		t.Fatalf("got %d, want 0", got)
	}
}

func TestRunUpdate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".ratchet.json")
	write := func(b Baseline) {
		data, _ := json.Marshal(b)
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	read := func() Baseline {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var b Baseline
		if err := json.Unmarshal(data, &b); err != nil {
			t.Fatal(err)
		}
		return b
	}
	measure := func(c Counts) func() (Counts, error) {
		return func() (Counts, error) { return c, nil }
	}
	var out bytes.Buffer

	write(Baseline{GoLines: 100, Deadcode: 10, Reason: "r"})
	if err := Run(path, false, measure(Counts{90, 5}), &out); err != nil {
		t.Fatalf("below should pass: %v", err)
	}
	if got := read(); got != (Baseline{100, 10, "r"}) {
		t.Fatalf("check without --update wrote the file: %+v", got)
	}
	if err := Run(path, true, measure(Counts{90, 5}), &out); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != (Baseline{90, 5, "r"}) {
		t.Fatalf("update did not lower: %+v", got)
	}
	// An above count under --update still fails and leaves the file alone.
	if err := Run(path, true, measure(Counts{95, 5}), &out); err == nil {
		t.Fatal("update with count above baseline must fail")
	}
	if got := read(); got != (Baseline{90, 5, "r"}) {
		t.Fatalf("update raised the baseline: %+v", got)
	}
	if err := Run(path, false, measure(Counts{}), &out); err != nil {
		t.Fatal(err)
	}
	if err := Run(path, false, func() (Counts, error) { return Counts{}, errors.New("boom") }, &out); err == nil {
		t.Fatal("measure error must surface")
	}
	if err := Run(filepath.Join(dir, "missing.json"), false, measure(Counts{}), &out); err == nil {
		t.Fatal("missing baseline must fail")
	}
}
