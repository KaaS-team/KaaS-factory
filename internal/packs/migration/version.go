package migration

import (
	"fmt"
	"strconv"
	"strings"
)

type version [3]int

type comparator struct {
	op string
	v  version
}

// parseVersion reads the numeric core of a version, ignoring a leading v, ^, ~, = and any suffix.
func parseVersion(s string) (version, error) {
	s = strings.TrimLeft(strings.TrimSpace(s), "v^~=")
	if i := strings.IndexAny(s, "-+ "); i >= 0 {
		s = s[:i]
	}
	var v version
	parts := strings.Split(s, ".")
	if s == "" || len(parts) > 3 {
		return v, fmt.Errorf("bad version %q", s)
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return v, fmt.Errorf("bad version %q", s)
		}
		v[i] = n
	}
	return v, nil
}

func parseRange(s string) ([]comparator, error) {
	var out []comparator
	for _, f := range strings.Fields(s) {
		op := "="
		for _, o := range []string{">=", "<=", "!=", ">", "<", "="} {
			if strings.HasPrefix(f, o) {
				op, f = o, strings.TrimPrefix(f, o)
				break
			}
		}
		v, err := parseVersion(f)
		if err != nil {
			return nil, err
		}
		out = append(out, comparator{op, v})
	}
	return out, nil
}

func cmp(a, b version) int {
	for i := range a {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func inRange(rng []comparator, v version) bool {
	for _, c := range rng {
		r := cmp(v, c.v)
		ok := map[string]bool{"=": r == 0, "!=": r != 0, ">": r > 0, ">=": r >= 0, "<": r < 0, "<=": r <= 0}[c.op]
		if !ok {
			return false
		}
	}
	return true
}
