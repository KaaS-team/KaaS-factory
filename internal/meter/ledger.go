package meter

import (
	"encoding/json"
	"fmt"
	"github.com/KaaS-team/factory/internal/marker"
	"math"
	"strconv"
	"strings"
)

// spendNote is the visible line above the hidden marker, as the TypeScript
// ledger writes it (src/adapters/github-store/spend.ts).
const spendNote = "Factory usage record (operator data, hidden)."

// Spend is one worker's running total in a `<!-- factory:spend v1 -->`
// comment. Day is set on a ledger issue's per-day comment and empty on a
// ticket's.
type Spend struct {
	Holder         string
	Day            string
	CostUSD        float64
	UnreportedRuns int
	Runs           int
	// Attempts holds per-attempt token rows. Comments written before they existed have none.
	Attempts []AttemptTokens
}

// AttemptTokens is the absolute token totals one attempt on a ticket reported.
type AttemptTokens struct {
	N          int
	Input      int64
	Output     int64
	CacheRead  int64
	CacheWrite int64
}

// attemptWire is AttemptTokens as it sits in the marker. Fields are pointers so a row with a
// missing or mistyped number is dropped rather than read as zero.
type attemptWire struct {
	N          *float64 `json:"n"`
	Input      *float64 `json:"in"`
	Output     *float64 `json:"out"`
	CacheRead  *float64 `json:"cacheRead"`
	CacheWrite *float64 `json:"cacheWrite"`
}

// EncodeSpend returns the comment body the TypeScript ledger writes for s:
// the note, a newline and the marker, with JSON.stringify's field order and
// number format.
func EncodeSpend(s Spend) string {
	var b strings.Builder
	b.WriteString(`{"holder":` + marker.JSString(s.Holder))
	if s.Day != "" {
		b.WriteString(",\"day\":" + marker.JSString(s.Day))
	}
	b.WriteString(",\"costUsd\":" + jsNumber(s.CostUSD))
	b.WriteString(",\"unreportedRuns\":" + strconv.Itoa(s.UnreportedRuns))
	b.WriteString(",\"runs\":" + strconv.Itoa(s.Runs))
	if len(s.Attempts) > 0 {
		b.WriteString(",\"attempts\":[")
		for i, a := range s.Attempts {
			if i > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, `{"n":%d,"in":%d,"out":%d,"cacheRead":%d,"cacheWrite":%d}`, a.N, a.Input, a.Output, a.CacheRead, a.CacheWrite)
		}
		b.WriteByte(']')
	}
	b.WriteByte('}')
	return spendNote + "\n" + marker.Wrap("spend", b.String())
}

// DecodeSpend returns every well-formed marker in body. A marker with a
// missing holder, or a missing, negative or non-numeric count, is dropped, so
// a forged one can add spend but never lift a cap.
func DecodeSpend(body string) ([]Spend, error) {
	var out []Spend
	for _, obj := range marker.Find(body, "spend") {
		var raw struct {
			Holder         *string           `json:"holder"`
			Day            string            `json:"day"`
			CostUSD        *float64          `json:"costUsd"`
			UnreportedRuns *float64          `json:"unreportedRuns"`
			Runs           *float64          `json:"runs"`
			Attempts       []json.RawMessage `json:"attempts"`
		}
		if json.Unmarshal([]byte(obj), &raw) != nil {
			continue
		}
		if raw.Holder == nil || !count(raw.CostUSD) || !count(raw.UnreportedRuns) || !count(raw.Runs) {
			continue
		}
		out = append(out, Spend{
			Holder:         *raw.Holder,
			Day:            raw.Day,
			CostUSD:        *raw.CostUSD,
			UnreportedRuns: int(*raw.UnreportedRuns),
			Runs:           int(*raw.Runs),
			Attempts:       attempts(raw.Attempts),
		})
	}
	return out, nil
}

// attempts keeps the well-formed rows: attempt number at least one, every count a finite
// non-negative number.
func attempts(in []json.RawMessage) []AttemptTokens {
	var out []AttemptTokens
	for _, r := range in {
		var w attemptWire
		if json.Unmarshal(r, &w) != nil {
			continue
		}
		if !count(w.N) || *w.N < 1 || !count(w.Input) || !count(w.Output) || !count(w.CacheRead) || !count(w.CacheWrite) {
			continue
		}
		out = append(out, AttemptTokens{N: int(*w.N), Input: int64(*w.Input), Output: int64(*w.Output),
			CacheRead: int64(*w.CacheRead), CacheWrite: int64(*w.CacheWrite)})
	}
	return out
}

func count(f *float64) bool { return f != nil && !math.IsNaN(*f) && !math.IsInf(*f, 0) && *f >= 0 }

// jsNumber formats f the way JavaScript's Number.prototype.toString does:
// plain digits from 1e-6 up to below 1e21, exponent form outside that.
func jsNumber(f float64) string {
	if f == 0 {
		return "0"
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde±XX
	i := strings.IndexByte(e, 'e')
	exp, _ := strconv.Atoi(e[i+1:])
	if exp < -6 || exp >= 21 {
		mant := e[:i]
		sign := "+"
		if exp < 0 {
			sign = "-"
			exp = -exp
		}
		return mant + "e" + sign + strconv.Itoa(exp)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}
