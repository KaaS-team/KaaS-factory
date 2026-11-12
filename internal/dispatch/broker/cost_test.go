package broker_test

import (
	"context"
	"runtime"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/dispatch/broker"
	"github.com/KaaS-team/factory/internal/dispatch/broker/brokertest"
)

func newGitHubBroker(tb testing.TB) *broker.Broker {
	c, err := broker.GitHub{TTL: time.Minute}.Open(context.Background(), brokertest.Source("tok"))
	if err != nil {
		tb.Fatal(err)
	}
	return broker.New(func(broker.Action) error { return nil }, c)
}

// BenchmarkRequest measures one classify, gate and mint round trip (see NOTE.md).
func BenchmarkRequest(b *testing.B) {
	br := newGitHubBroker(b)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := br.Request(context.Background(), "github", "POST", "/repos/o/r/pulls"); err != nil {
			b.Fatal(err)
		}
	}
}

// TestBrokerHeapStaysSmall pins the RAM claim in NOTE.md: a broker with one adapter holds under 1 MiB.
func TestBrokerHeapStaysSmall(t *testing.T) {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	brs := make([]*broker.Broker, 100)
	for i := range brs {
		brs[i] = newGitHubBroker(t)
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	runtime.KeepAlive(brs)
	per := (int64(after.HeapAlloc) - int64(before.HeapAlloc)) / 100
	t.Logf("heap per broker: %d bytes", per)
	if per > 1<<20 {
		t.Fatalf("%d bytes per broker", per)
	}
}
