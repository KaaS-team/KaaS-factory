package config

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
)

// coerce turns a raw YAML, env or flag value into the Go type of the key's kind.
func coerce(sp spec, raw any) (any, error) {
	switch sp.kind {
	case kString:
		return coerceString(raw)
	case kInt:
		return coerceInt(sp, raw)
	case kFloat:
		return coerceFloat(raw)
	case kDuration:
		return coerceDuration(raw)
	case kList:
		return toList(raw)
	case kBool:
		return coerceBool(raw)
	case kRole:
		return coerceOneOf(raw, roles)
	case kRisk:
		return coerceOneOf(raw, risks)
	}
	return nil, fmt.Errorf("unsupported kind")
}

func coerceString(raw any) (any, error) {
	s, ok := raw.(string)
	if !ok {
		return nil, fmt.Errorf("expected a string, got %v", raw)
	}
	return s, nil
}

func coerceInt(sp spec, raw any) (any, error) {
	n, err := toFloat(raw)
	if err != nil || n != math.Trunc(n) {
		return nil, fmt.Errorf("expected a whole number, got %v", raw)
	}
	if n < sp.min {
		return nil, fmt.Errorf("expected at least %v, got %v", sp.min, raw)
	}
	return int(n), nil
}

func coerceFloat(raw any) (any, error) {
	n, err := toFloat(raw)
	if err != nil || n < 0 {
		return nil, fmt.Errorf("expected a number of 0 or more, got %v", raw)
	}
	return n, nil
}

func coerceDuration(raw any) (any, error) {
	if d, ok := raw.(time.Duration); ok {
		return d, nil
	}
	s, ok := raw.(string)
	if !ok {
		return nil, fmt.Errorf("expected a duration such as 30m, got %v", raw)
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return nil, fmt.Errorf("expected a positive duration such as 30m, got %q", s)
	}
	return d, nil
}

func coerceBool(raw any) (any, error) {
	switch b := raw.(type) {
	case bool:
		return b, nil
	case string:
		if v, err := strconv.ParseBool(b); err == nil {
			return v, nil
		}
	}
	return nil, fmt.Errorf("expected true or false, got %v", raw)
}

// coerceOneOf accepts a string that is in allowed.
func coerceOneOf(raw any, allowed []string) (any, error) {
	s, _ := raw.(string)
	if !slices.Contains(allowed, s) {
		return nil, fmt.Errorf("expected one of %s, got %v", strings.Join(allowed, ", "), raw)
	}
	return s, nil
}

func toFloat(raw any) (float64, error) {
	switch n := raw.(type) {
	case int:
		return float64(n), nil
	case int64:
		return float64(n), nil
	case uint64:
		return float64(n), nil
	case float64:
		return n, nil
	case string:
		return strconv.ParseFloat(strings.TrimSpace(n), 64)
	}
	return 0, fmt.Errorf("not a number")
}

func toList(raw any) ([]string, error) {
	switch l := raw.(type) {
	case []string:
		return slices.Clone(l), nil
	case string:
		out := []string{}
		for p := range strings.SplitSeq(l, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out, nil
	case []any:
		out := make([]string, 0, len(l))
		for _, e := range l {
			s, ok := e.(string)
			if !ok {
				return nil, fmt.Errorf("expected a list of strings, got entry %v", e)
			}
			out = append(out, s)
		}
		return out, nil
	}
	return nil, fmt.Errorf("expected a list of strings, got %v", raw)
}
