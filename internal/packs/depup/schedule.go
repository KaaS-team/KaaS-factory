package depup

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// Schedule is a five-field cron expression read in a time zone. The zero value allows every minute.
type Schedule struct {
	loc                   *time.Location
	min, hour, dom, mon   uint64
	dow                   uint64
	domStar, dowStar, set bool
}

// ParseSchedule reads "min hour dom mon dow" (lists, ranges, steps, * and 7 for Sunday) in the named
// zone. An empty expression allows every minute; an empty zone means UTC.
func ParseSchedule(cron, tz string) (Schedule, error) {
	s := Schedule{loc: time.UTC}
	if tz != "" {
		loc, err := time.LoadLocation(tz)
		if err != nil {
			return s, fmt.Errorf("schedule time zone: %w", err)
		}
		s.loc = loc
	}
	if strings.TrimSpace(cron) == "" {
		return s, nil
	}
	f := strings.Fields(cron)
	if len(f) != 5 {
		return s, fmt.Errorf("schedule %q: want 5 fields, got %d", cron, len(f))
	}
	bounds := [5][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}
	var masks [5]uint64
	for i, field := range f {
		m, err := parseField(field, bounds[i][0], bounds[i][1])
		if err != nil {
			return s, fmt.Errorf("schedule %q: %w", cron, err)
		}
		masks[i] = m
	}
	if masks[4]&(1<<7) != 0 { // 7 is Sunday too
		masks[4] |= 1
	}
	s.min, s.hour, s.dom, s.mon, s.dow = masks[0], masks[1], masks[2], masks[3], masks[4]
	s.domStar, s.dowStar, s.set = f[2] == "*", f[4] == "*", true
	return s, nil
}

func parseField(field string, lo, hi int) (uint64, error) {
	var mask uint64
	for _, part := range strings.Split(field, ",") {
		rng, stepS, hasStep := strings.Cut(part, "/")
		step := 1
		if hasStep {
			n, err := strconv.Atoi(stepS)
			if err != nil || n < 1 {
				return 0, fmt.Errorf("bad step %q", part)
			}
			step = n
		}
		a, b := lo, hi
		if rng != "*" {
			as, bs, isRange := strings.Cut(rng, "-")
			var err1, err2 error
			a, err1 = strconv.Atoi(as)
			b = a
			if isRange {
				b, err2 = strconv.Atoi(bs)
			} else if hasStep {
				b = hi
			}
			if err1 != nil || err2 != nil || a < lo || b > hi || a > b {
				return 0, fmt.Errorf("bad range %q", part)
			}
		}
		for v := a; v <= b; v += step {
			mask |= 1 << uint(v)
		}
	}
	return mask, nil
}

// Allows probes the minute containing t: it is allowed when the cron fields match the local time
// there. A local minute skipped by a DST jump never matches; a repeated one matches both times.
func (s Schedule) Allows(t time.Time) bool {
	if !s.set {
		return true
	}
	l := t.In(s.loc)
	has := func(m uint64, v int) bool { return m&(1<<uint(v)) != 0 }
	day := has(s.dom, l.Day())
	wd := has(s.dow, int(l.Weekday()))
	switch { // standard cron: when both day fields are restricted, either may match
	case s.domStar:
		day = wd
	case s.dowStar:
	default:
		day = day || wd
	}
	return has(s.min, l.Minute()) && has(s.hour, l.Hour()) && has(s.mon, int(l.Month())) && day
}

// AutomergeAllowed reports whether the automerge schedule permits merging at t.
func AutomergeAllowed(s Schedule, t time.Time) bool { return s.Allows(t) }

// Limits caps new upgrade tickets. Zero means no cap.
type Limits struct{ Hourly, Concurrent int }

// Outcome says why a firing did or did not create tickets.
type Outcome int

// The outcomes of Decide.
const (
	Run Outcome = iota
	OutsideSchedule
	HourlyLimit
	ConcurrentLimit
)

var outcomeNames = [...]string{"run", "outside-schedule", "hourly-limit", "concurrent-limit"}

// String is the stable name written to logs.
func (o Outcome) String() string { return outcomeNames[o] }

// Decide checks the schedule, then the limits. It counts depup tickets the tracker still lists as active
// (concurrent) and those created in the last hour (hourly), so nothing lives in memory across a restart.
func Decide(ctx context.Context, tr api.Lister, s Schedule, l Limits, now time.Time) (Outcome, error) {
	if !s.Allows(now) {
		return OutsideSchedule, nil
	}
	active, err := tr.Active(ctx)
	if err != nil {
		return Run, fmt.Errorf("read active tickets: %w", err)
	}
	var open, recent int
	for _, t := range active {
		if !hasLabel(t.Labels, Label) {
			continue
		}
		open++
		if now.Sub(t.CreatedAt) < time.Hour {
			recent++
		}
	}
	switch {
	case l.Concurrent > 0 && open >= l.Concurrent:
		return ConcurrentLimit, nil
	case l.Hourly > 0 && recent >= l.Hourly:
		return HourlyLimit, nil
	}
	return Run, nil
}

func hasLabel(ls []string, v string) bool {
	for _, x := range ls {
		if x == v {
			return true
		}
	}
	return false
}
