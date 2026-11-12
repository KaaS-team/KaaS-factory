package shadow

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/spf13/cobra"
)

// DefaultPath is where the file writer logs, relative to the repo root. The
// path is gitignored and the file is never committed.
const DefaultPath = ".factory/shadow.ndjson"

// FileWriter appends one JSON line per record to a file.
type FileWriter struct {
	mu   sync.Mutex
	path string
}

// NewFileWriter returns a Writer that appends to path, creating its directory.
func NewFileWriter(path string) *FileWriter { return &FileWriter{path: path} }

// Write appends r as one line.
func (f *FileWriter) Write(r Record) error {
	line, err := json.Marshal(r)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(f.path), 0o755); err != nil {
		return err
	}
	fh, err := os.OpenFile(f.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := fh.Write(append(line, '\n')); err != nil {
		_ = fh.Close()
		return err
	}
	return fh.Close()
}

type tally struct {
	dispatches, steers, cancels int
	dispatcher                  string
}

// Summary reads an NDJSON log and prints, per UTC day and per ticket, what
// would have run.
func Summary(r io.Reader, w io.Writer) error {
	days := map[string]map[api.TicketID]*tally{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for n := 1; sc.Scan(); n++ {
		if strings.TrimSpace(sc.Text()) == "" {
			continue
		}
		var rec Record
		if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
			return fmt.Errorf("shadow: line %d: %w", n, err)
		}
		day := rec.Time.UTC().Format("2006-01-02")
		if days[day] == nil {
			days[day] = map[api.TicketID]*tally{}
		}
		t := days[day][rec.Ticket]
		if t == nil {
			t = &tally{}
			days[day][rec.Ticket] = t
		}
		t.dispatcher = rec.Dispatcher
		switch rec.Action {
		case ActionDispatch:
			t.dispatches++
		case ActionSteer:
			t.steers++
		case ActionCancel:
			t.cancels++
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if len(days) == 0 {
		_, err := fmt.Fprintln(w, "no shadow records")
		return err
	}
	dayNames := make([]string, 0, len(days))
	for d := range days {
		dayNames = append(dayNames, d)
	}
	sort.Strings(dayNames)
	for _, d := range dayNames {
		if _, err := fmt.Fprintln(w, d); err != nil {
			return err
		}
		ids := make([]string, 0, len(days[d]))
		for id := range days[d] {
			ids = append(ids, string(id))
		}
		sort.Strings(ids)
		for _, id := range ids {
			t := days[d][api.TicketID(id)]
			if _, err := fmt.Fprintf(w, "  %s: %s (would use %s)\n", id, t.describe(), t.dispatcher); err != nil {
				return err
			}
		}
	}
	return nil
}

func (t *tally) describe() string {
	var parts []string
	for _, p := range []struct {
		n    int
		noun string
	}{{t.dispatches, "dispatch"}, {t.steers, "steer"}, {t.cancels, "cancel"}} {
		switch {
		case p.n == 1:
			parts = append(parts, "1 "+p.noun)
		case p.n > 1:
			noun := p.noun
			if noun == "dispatch" {
				noun += "es"
			} else {
				noun += "s"
			}
			parts = append(parts, fmt.Sprintf("%d %s", p.n, noun))
		}
	}
	return strings.Join(parts, ", ")
}

// NewCommand returns `shadow`: a per-day, per-ticket summary of what shadow mode would have run.
func NewCommand() *cobra.Command {
	path := DefaultPath
	cmd := &cobra.Command{
		Use:          "shadow",
		Short:        "Summarize what shadow mode would have dispatched",
		Args:         cobra.NoArgs,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			f, err := os.Open(path)
			if os.IsNotExist(err) {
				_, err = fmt.Fprintln(cmd.OutOrStdout(), "no shadow records")
				return err
			}
			if err != nil {
				return err
			}
			defer func() { _ = f.Close() }()
			return Summary(f, cmd.OutOrStdout())
		},
	}
	cmd.Flags().StringVar(&path, "file", DefaultPath, "shadow log to read")
	return cmd
}
