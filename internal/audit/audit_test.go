package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixed(t *testing.T, ts time.Time) {
	t.Helper()
	old := now
	now = func() time.Time { return ts }
	t.Cleanup(func() { now = old })
}

func TestRecordWritesDailyJSONLWithRedaction(t *testing.T) {
	dir := t.TempDir()
	fixed(t, time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC))
	defer SetSink(&File{Dir: dir})()
	ctx := WithActor(context.Background(), "bot-1")
	Record(ctx, "tracker.comment", "12", "12", nil)
	Record(ctx, "tracker.set_phase", "12", "12", errors.New("denied for ghp_abcdefghijklmnopqrstuvwxyz0123"))

	raw, err := os.ReadFile(filepath.Join(dir, "2026-03-04.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %d, want 2", len(lines))
	}
	var ok, bad Entry
	if err := json.Unmarshal([]byte(lines[0]), &ok); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &bad); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{KeyActor: "bot-1", KeyAction: "tracker.comment", KeyTarget: "12", KeyResult: "ok", KeyTicket: "12"}
	for k, v := range want {
		if ok.Attributes[k] != v {
			t.Errorf("attr %s = %q, want %q", k, ok.Attributes[k], v)
		}
	}
	if ok.SeverityText != "INFO" || bad.SeverityText != "ERROR" || bad.Attributes[KeyResult] != "error" {
		t.Errorf("severity/result wrong: %+v %+v", ok, bad)
	}
	if strings.Contains(string(raw), "ghp_") || !strings.Contains(bad.Body, "[redacted]") {
		t.Errorf("secret reached the file: %s", lines[1])
	}
}

func TestRecordWithoutSinkDoesNothing(t *testing.T) {
	defer SetSink(nil)()
	Record(context.Background(), "x", "y", "", nil) // must not panic
}

func TestExportSinceAndCSV(t *testing.T) {
	dir := t.TempDir()
	f := &File{Dir: dir}
	base := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	for _, d := range []int{9, 2, 0} {
		ts := base.AddDate(0, 0, -d)
		e := Entry{Timestamp: ts, SeverityText: "INFO", Body: "b", Attributes: map[string]string{KeyAction: "a" + ts.Format("02"), KeyActor: "me"}}
		if err := f.Write(context.Background(), e); err != nil {
			t.Fatal(err)
		}
	}
	var out bytes.Buffer
	if err := Export(dir, base.AddDate(0, 0, -7), "jsonl", &out); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(out.String(), "\n"); n != 2 || strings.Contains(out.String(), "a01") {
		t.Fatalf("jsonl export:\n%s", out.String())
	}
	out.Reset()
	if err := Export(dir, base.AddDate(0, 0, -7), "csv", &out); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "timestamp,severity,actor,action,target,result,ticket,body\n") || strings.Count(out.String(), "\n") != 3 {
		t.Fatalf("csv export:\n%s", out.String())
	}
	if err := Export(dir, base, "xml", &out); err == nil {
		t.Fatal("unknown format accepted")
	}
}

func TestParseSince(t *testing.T) {
	if d, err := ParseSince("7d"); err != nil || d != 7*24*time.Hour {
		t.Fatalf("7d = %v %v", d, err)
	}
	if d, err := ParseSince("90m"); err != nil || d != 90*time.Minute {
		t.Fatalf("90m = %v %v", d, err)
	}
	if _, err := ParseSince("soon"); err == nil {
		t.Fatal("bad value accepted")
	}
}

func TestOTLPReceiverGetsRecordsWhenEnvSet(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	var bodies [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		paths, bodies = append(paths, r.URL.Path), append(bodies, b)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer srv.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", srv.URL)

	o, err := NewOTLPFromEnv(context.Background())
	if err != nil || o == nil {
		t.Fatalf("NewOTLPFromEnv = %v, %v", o, err)
	}
	defer SetSink(o)()
	Record(WithActor(context.Background(), "bot-9"), "dispatch.start", "ticket-77", "77", nil)
	if err := o.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) == 0 || paths[0] != "/v1/logs" {
		t.Fatalf("collector got paths %v", paths)
	}
	for _, want := range []string{"dispatch.start", "bot-9", "ticket-77", "actor", "result"} {
		if !bytes.Contains(bodies[0], []byte(want)) {
			t.Errorf("OTLP body lacks %q", want)
		}
	}
}

func TestOTLPOffWithoutEnv(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "")
	if o, err := NewOTLPFromEnv(context.Background()); o != nil || err != nil {
		t.Fatalf("got %v %v, want nil", o, err)
	}
}
