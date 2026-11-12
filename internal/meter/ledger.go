package meter

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// spendNote is the visible line above the hidden marker, as the TypeScript
// ledger writes it (src/adapters/github-store/spend.ts).
const spendNote = "Factory usage record (operator data, hidden)."

var spendMarker = regexp.MustCompile(`<!-- factory:spend (\{.*?\}) -->`)

// Spend is one worker's running total in a `<!-- factory:spend v1 -->`
// comment. Day is set on a ledger issue's per-day comment and empty on a
// ticket's.
type Spend struct {
	Holder         string
	Day            string
	CostUSD        float64
	UnreportedRuns int
	Runs           int
}

// EncodeSpend returns the comment body the TypeScript ledger writes for s:
// the note, a newline and the marker, with JSON.stringify's field order and
// number format.
func EncodeSpend(s Spend) string {
	var b strings.Builder
	b.WriteString(spendNote + "\n<!-- factory:spend {\"holder\":")
	b.WriteString(jsString(s.Holder))
	if s.Day != "" {
		b.WriteString(",\"day\":" + jsString(s.Day))
	}
	b.WriteString(",\"costUsd\":" + jsNumber(s.CostUSD))
	b.WriteString(",\"unreportedRuns\":" + strconv.Itoa(s.UnreportedRuns))
	b.WriteString(",\"runs\":" + strconv.Itoa(s.Runs))
	b.WriteString("} -->")
	return b.String()
}

// DecodeSpend returns every well-formed marker in body. A marker with a
// missing holder, or a missing, negative or non-numeric count, is dropped, so
// a forged one can add spend but never lift a cap.
func DecodeSpend(body string) ([]Spend, error) {
	var out []Spend
	for _, m := range spendMarker.FindAllStringSubmatch(body, -1) {
		var raw struct {
			Holder         *string  `json:"holder"`
			Day            string   `json:"day"`
			CostUSD        *float64 `json:"costUsd"`
			UnreportedRuns *float64 `json:"unreportedRuns"`
			Runs           *float64 `json:"runs"`
		}
		if json.Unmarshal([]byte(m[1]), &raw) != nil {
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
		})
	}
	return out, nil
}

func count(f *float64) bool { return f != nil && !math.IsNaN(*f) && !math.IsInf(*f, 0) && *f >= 0 }

// jsString is JSON.stringify for a string: no HTML escaping, and U+2028 and
// U+2029 left as they are.
func jsString(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s) // a string always encodes
	out := strings.TrimSuffix(buf.String(), "\n")
	out = strings.ReplaceAll(out, ` `, " ")
	return strings.ReplaceAll(out, ` `, " ")
}

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
