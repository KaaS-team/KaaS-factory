package audit

import (
	"bufio"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ParseSince reads "7d", "12h" or any time.ParseDuration string.
func ParseSince(s string) (time.Duration, error) {
	if n, ok := strings.CutSuffix(s, "d"); ok {
		d, err := strconv.Atoi(n)
		if err != nil || d < 0 {
			return 0, fmt.Errorf("audit: bad --since %q", s)
		}
		return time.Duration(d) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d < 0 {
		return 0, fmt.Errorf("audit: bad --since %q", s)
	}
	return d, nil
}

// Export writes the records in dir at or after since, oldest first, as "jsonl" or "csv".
func Export(dir string, since time.Time, format string, w io.Writer) error {
	if format != "jsonl" && format != "csv" {
		return fmt.Errorf("audit: unknown format %q (jsonl or csv)", format)
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil {
		return err
	}
	sort.Strings(files)
	var cw *csv.Writer
	if format == "csv" {
		cw = csv.NewWriter(w)
		if err := cw.Write([]string{"timestamp", "severity", "actor", "action", "target", "result", "ticket", "body"}); err != nil {
			return err
		}
	}
	for _, f := range files {
		if err := exportFile(f, since, cw, w); err != nil {
			return err
		}
	}
	if cw != nil {
		cw.Flush()
		return cw.Error()
	}
	return nil
}

func exportFile(path string, since time.Time, cw *csv.Writer, w io.Writer) error {
	h, err := os.Open(filepath.Clean(path))
	if err != nil {
		return err
	}
	defer func() { _ = h.Close() }()
	sc := bufio.NewScanner(h)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var r Entry
		if json.Unmarshal(sc.Bytes(), &r) != nil || r.Timestamp.Before(since) {
			continue
		}
		if cw == nil {
			if _, err := fmt.Fprintf(w, "%s\n", sc.Bytes()); err != nil {
				return err
			}
			continue
		}
		a := r.Attributes
		if err := cw.Write([]string{r.Timestamp.Format(time.RFC3339), r.SeverityText, a[KeyActor], a[KeyAction], a[KeyTarget], a[KeyResult], a[KeyTicket], r.Body}); err != nil {
			return err
		}
	}
	return sc.Err()
}
