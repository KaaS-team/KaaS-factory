// Ported from triggerdotdev/trigger.dev@2fbd5c7 internal-packages/schedule-engine/src/engine/distributedScheduling.ts

package serve

import (
	"hash/fnv"
	"time"
)

// DefaultJitterWindow is the upstream default: how far before its tick a job may start.
const DefaultJitterWindow = 30 * time.Second

// JitterOffset is a deterministic offset in [0, window] for a tick and instance: FNV-1a (with a final
// mix) over the tick's ISO time and the instance id, so the same inputs always give the same start and
// teammates spread out.
func JitterOffset(nominal time.Time, window time.Duration, instance string) time.Duration {
	if window <= 0 {
		return 0
	}
	seed := nominal.UTC().Format("2006-01-02T15:04:05.000Z")
	if instance != "" {
		seed += ":" + instance
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(seed))
	// FNV-1a keeps ids that differ in one character close together, so a murmur3 finalizer spreads them.
	x := h.Sum32()
	x ^= x >> 16
	x *= 0x85ebca6b
	x ^= x >> 13
	x *= 0xc2b2ae35
	x ^= x >> 16
	ms := int64(float64(x) / 0xffffffff * float64(window.Milliseconds()))
	return time.Duration(ms) * time.Millisecond
}

// SetJitter lets each tick start up to window before its nominal time, seeded by instance. A zero
// window (the default) keeps every tick on time. The run is still keyed by the nominal period.
func (j *Jobs) SetJitter(window time.Duration, instance string) {
	j.jitter, j.instance = window, instance
}

// due reports whether the cron tick t may start at now.
func (j *Jobs) due(t, now time.Time) bool {
	return !t.Add(-JitterOffset(t, j.jitter, j.instance)).After(now)
}
