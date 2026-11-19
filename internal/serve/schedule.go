// Ported from triggerdotdev/trigger.dev@2fbd5c7cf4e9c8e19b88e2b72a7133795611e33d internal-packages/schedule-engine/src/engine/scheduleCalculation.ts
// Ported from triggerdotdev/trigger.dev@2fbd5c7cf4e9c8e19b88e2b72a7133795611e33d internal-packages/schedule-engine/src/engine/distributedScheduling.ts
package serve

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/robfig/cron/v3"
)

// maxScheduleCatchUp bounds the ticks walked in one pass; a longer outage resumes on the next pass.
const maxScheduleCatchUp = 100_000

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
		for t := c.Next(last); n < maxScheduleCatchUp && !t.Add(-JitterOffset(t, window, sc.Instance)).After(now); t = c.Next(t) {
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
