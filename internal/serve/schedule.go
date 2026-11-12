// Ported from triggerdotdev/trigger.dev@2fbd5c7cf4e9c8e19b88e2b72a7133795611e33d internal-packages/schedule-engine/src/engine/scheduleCalculation.ts
// Ported from triggerdotdev/trigger.dev@2fbd5c7cf4e9c8e19b88e2b72a7133795611e33d internal-packages/schedule-engine/src/engine/distributedScheduling.ts
package serve

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"time"

	"github.com/robfig/cron/v3"
)

// DefaultJitterWindow is how far before its tick a schedule may start (the upstream default of 30 seconds).
const DefaultJitterWindow = 30 * time.Second

// maxCatchUp bounds the ticks walked in one pass; a longer outage resumes on the next pass.
const maxCatchUp = 100_000

// Schedule is one cron entry: a name, a five-field spec and an optional IANA zone (empty means UTC).
type Schedule struct{ Name, Spec, Zone string }

// Occurrence is one firing: the nominal cron tick, and whether earlier missed ticks were dropped.
type Occurrence struct {
	Name    string
	Nominal time.Time
	Skipped bool
}

// Store remembers the last nominal tick fired for each schedule, so a restart can see what it missed.
type Store interface {
	Last(name string) (time.Time, bool)
	Set(name string, nominal time.Time) error
}

// JitterOffset is a deterministic offset in [0, window] for a tick and instance: FNV-1a (with a final mix) over the tick's
// ISO time and the instance id, so the same inputs always give the same start and teammates spread out.
func JitterOffset(nominal time.Time, window time.Duration, instance string) time.Duration {
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

// Scheduler fires schedules whose tick has come, and after downtime fires only the latest missed tick.
type Scheduler struct {
	Schedules []Schedule
	Store     Store
	Fire      func(ctx context.Context, o Occurrence) error
	Window    time.Duration // jitter window; zero means DefaultJitterWindow
	Instance  string        // seeds the jitter so teammates on one cron spread out
}

func (s Schedule) parse() (cron.Schedule, error) {
	spec := s.Spec
	if s.Zone != "" {
		if _, err := time.LoadLocation(s.Zone); err != nil {
			return nil, fmt.Errorf("schedule %s: %w", s.Name, err)
		}
		spec = "CRON_TZ=" + s.Zone + " " + spec
	}
	c, err := cron.ParseStandard(spec)
	if err != nil {
		return nil, fmt.Errorf("schedule %s: %w", s.Name, err)
	}
	return c, nil
}

// Validate reports the first schedule whose spec or zone does not parse.
func (sc *Scheduler) Validate() error {
	for _, s := range sc.Schedules {
		if _, err := s.parse(); err != nil {
			return err
		}
	}
	return nil
}

// Tick fires each schedule that is due at now. A schedule seen for the first time starts from now, so
// history before the first run is not replayed. A failed Fire leaves the schedule due for the next tick.
func (sc *Scheduler) Tick(ctx context.Context, now time.Time) error {
	window := sc.Window
	if window <= 0 {
		window = DefaultJitterWindow
	}
	for _, s := range sc.Schedules {
		c, err := s.parse()
		if err != nil {
			return err
		}
		last, ok := sc.Store.Last(s.Name)
		if !ok {
			if err := sc.Store.Set(s.Name, now); err != nil {
				return err
			}
			continue
		}
		var latest time.Time
		n := 0
		for t := c.Next(last); n < maxCatchUp && !t.Add(-JitterOffset(t, window, sc.Instance)).After(now); t = c.Next(t) {
			latest = t
			n++
		}
		if n == 0 {
			continue
		}
		if err := sc.Fire(ctx, Occurrence{Name: s.Name, Nominal: latest, Skipped: n > 1}); err != nil {
			return fmt.Errorf("schedule %s: %w", s.Name, err)
		}
		if err := sc.Store.Set(s.Name, latest); err != nil {
			return err
		}
	}
	return nil
}

// FileStore keeps last-fired ticks in one JSON file, replaced atomically on every write.
type FileStore struct {
	Path string
	last map[string]time.Time
}

// OpenFileStore reads path; a missing file is an empty store.
func OpenFileStore(path string) (*FileStore, error) {
	f := &FileStore{Path: path, last: map[string]time.Time{}}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return f, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &f.last); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return f, nil
}

// Last returns the tick last fired for name.
func (f *FileStore) Last(name string) (time.Time, bool) { t, ok := f.last[name]; return t, ok }

// Set records the tick fired for name and writes the file.
func (f *FileStore) Set(name string, nominal time.Time) error {
	f.last[name] = nominal.UTC()
	b, err := json.Marshal(f.last)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
		return err
	}
	tmp := f.Path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, f.Path)
}
