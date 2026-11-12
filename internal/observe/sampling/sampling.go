// Ported from langfuse/langfuse@2e6d034 worker/src/features/evaluation/deterministicSampling.ts

// Package sampling decides, the same way on every run, whether a ticket's
// trace is judged, and maps OTLP usage attributes to meter usage.
package sampling

import (
	"crypto/sha256"
	"encoding/binary"
)

const domain = "kaas-factory:eval-sampling:v1\x00"

// Value hashes the target to a stable number in [0, 1), using 53 bits so every bucket is distinct.
func Value(target string) float64 {
	h := sha256.New()
	h.Write([]byte(domain))
	h.Write([]byte(target))
	bits := binary.BigEndian.Uint64(h.Sum(nil)[:8]) >> 11
	return float64(bits) / (1 << 53)
}

// Sample reports whether a sampling value falls under the rate; rate 1 or more always samples, 0 or less never.
func Sample(value, rate float64) bool {
	if rate >= 1 {
		return true
	}
	if rate <= 0 {
		return false
	}
	return value < rate
}

// Rates holds the judge-eval sampling rate per rule name, and the rate for rules not listed.
type Rates struct {
	Default float64
	Rules   map[string]float64
}

// Should reports whether the rule judges the target, using the rule's rate or the default.
func (r Rates) Should(rule, target string) bool {
	rate, ok := r.Rules[rule]
	if !ok {
		rate = r.Default
	}
	return Sample(Value(target), rate)
}
