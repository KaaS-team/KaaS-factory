// Ported from dagger/dagger@835b0ef806b277fb216735a180d1a542c2937024 util/scrub/scrub.go

package replay

import (
	"regexp"
	"strings"
)

type scrubber struct {
	re   *regexp.Regexp
	repl string
}

const month = `Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec`

// scrubs run in order, so the longer timestamp forms come before the bare
// date and clock forms they contain, and ports before the addresses they follow.
var scrubs = []scrubber{
	// digests
	{regexp.MustCompile(`sha256:[a-f0-9]{64}`), "sha256:" + strings.Repeat("X", 64)},
	{regexp.MustCompile(`xxh3:[a-f0-9]{16}`), "xxh3:" + strings.Repeat("X", 16)},
	// timestamps and dates
	{regexp.MustCompile(`\b20\d{2}-\d{2}-\d{2}T\d+:\d+:\d+\.\d+Z\b`), "XXXX-XX-XXTXX:XX:XX.XXXZ"},
	{regexp.MustCompile(`\b20\d{2}-\d{2}-\d{2} \d+:\d+:\d+\.\d+`), "20XX-XX-XX XX:XX:XX.XXXX"},
	{regexp.MustCompile(`\b20\d{2}-\d{2}-\d{2}\b`), "20XX-XX-XX"},
	{regexp.MustCompile(`\b\d+/(` + month + `)/20\d{2}\b`), "XX/XXX/20XX"},
	{regexp.MustCompile(`\b\d+:\d+:\d+\b`), "XX:XX:XX"},
	// ports
	{regexp.MustCompile(`(localhost|\d+\.\d+\.\d+\.\d+|\[[0-9a-f:.]+\]):\d{2,5}\b`), "$1:XXXXX"},
	{regexp.MustCompile(`\b([Pp]ort) \d{2,5}\b`), "$1 XXXXX"},
	// addresses and process ids
	{regexp.MustCompile(`\b10\.\d+\.\d+\.\d+\b`), "10.XX.XX.XX"},
	{regexp.MustCompile(`\bpid=\d+\b`), "pid=X"},
	{regexp.MustCompile(`0x[0-9a-f]+`), "0xXXXXXXXXXXXX"},
	// durations
	{regexp.MustCompile(`\b(\d+m)?\d+(\.\d+)?s\b`), "X.Xs"},
	{regexp.MustCompile(`\d+(\.\d+)?(µs|ms|s)\b`), "X.Xs"},
	{regexp.MustCompile(`\d+(\.\d+)?\s(seconds|minutes)`), "X.X seconds"},
	// sizes
	{regexp.MustCompile(`\b\d+(\.\d+)?\s?(B|kB|MB|GB|TB)\b`), "X.X B"},
	{regexp.MustCompile(`\b\d+ bytes`), "XX bytes"},
	// trailing whitespace
	{regexp.MustCompile(`[ \t]+\n`), "\n"},
}

// Stabilize rewrites the parts of model or tool output that change between
// runs (digests, sizes, timings, ports, addresses) to fixed placeholders.
func Stabilize(out string) string {
	for _, s := range scrubs {
		out = s.re.ReplaceAllString(out, s.repl)
	}
	return out
}
