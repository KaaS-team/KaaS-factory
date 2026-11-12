package shadow_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/dispatch/shadow"
)

func TestFileWriterAppendsOneLinePerRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".factory", "shadow.ndjson")
	d := shadow.New(porttest.NewDispatcher(1), shadow.NewFileWriter(path))
	for i := 1; i <= 2; i++ {
		if _, err := d.Dispatch(context.Background(), brief("7", i)); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(lines) != 2 || strings.Contains(lines[0], "\n") {
		t.Fatalf("lines = %q", lines)
	}
	var out bytes.Buffer
	if err := shadow.Summary(bytes.NewReader(raw), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "7: 2 dispatches") {
		t.Fatalf("summary = %q", out.String())
	}
}

func TestDefaultPath(t *testing.T) {
	if shadow.DefaultPath != ".factory/shadow.ndjson" {
		t.Fatal(shadow.DefaultPath)
	}
}

// Acceptance 3: summary of a fixture log groups by day and ticket (golden).
func TestSummaryGolden(t *testing.T) {
	in, err := os.Open("testdata/shadow.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = in.Close() }()
	var out bytes.Buffer
	if err := shadow.Summary(in, &out); err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/summary.golden")
	if err != nil {
		t.Fatal(err)
	}
	if out.String() != string(want) {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
}

func TestSummaryRejectsBadLine(t *testing.T) {
	var out bytes.Buffer
	if err := shadow.Summary(strings.NewReader("{nope\n"), &out); err == nil {
		t.Fatal("want error")
	}
}

func TestSummaryEmpty(t *testing.T) {
	var out bytes.Buffer
	if err := shadow.Summary(strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != "no shadow records\n" {
		t.Fatalf("out = %q", out.String())
	}
}

func TestSummaryDaysUTC(t *testing.T) {
	late := time.Date(2026, 3, 4, 23, 30, 0, 0, time.FixedZone("x", -5*3600))
	line := `{"time":"` + late.Format(time.RFC3339) + `","action":"dispatch","ticket":"9","attempt":1,"dispatcher":"routines"}` + "\n"
	var out bytes.Buffer
	if err := shadow.Summary(strings.NewReader(line), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "2026-03-05") {
		t.Fatalf("out = %q", out.String())
	}
}
