package broker_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/dispatch/broker"
)

// BenchmarkRequestFileSource measures a full round trip including the per-mint file read (see NOTE.md).
func BenchmarkRequestFileSource(b *testing.B) {
	p := filepath.Join(b.TempDir(), "tok")
	if err := os.WriteFile(p, []byte("tok"), 0o600); err != nil {
		b.Fatal(err)
	}
	c, err := broker.GitHub{TTL: time.Minute}.Open(context.Background(), broker.FileSource(p))
	if err != nil {
		b.Fatal(err)
	}
	br := broker.New(func(broker.Action) error { return nil }, c)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := br.Request(context.Background(), "github", "GET", "/repos/o/r"); err != nil {
			b.Fatal(err)
		}
	}
}
