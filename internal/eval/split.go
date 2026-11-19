package eval

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/spf13/cobra"
)

// Split names the half of the samples a run may see. The shape follows Inspect AI (MIT): a task
// lists samples, each sample has a stable id, and the split is a pure function of that id.
type Split string

// The two splits. Tuning runs use dev. Holdout runs only when --split holdout is named.
const (
	SplitDev     Split = "dev"
	SplitHoldout Split = "holdout"
)

// holdoutPercent is the share of samples that land in the holdout.
const holdoutPercent = 20

// SampleID names one sample: its fixture and ticket.
func SampleID(fixture string, ticket api.TicketID) string { return fixture + "/" + string(ticket) }

// SplitOf puts a sample id in a split. It hashes the id with sha256, so the answer is the same on
// every run and every machine, and adding a sample never moves another.
func SplitOf(id string) Split {
	sum := sha256.Sum256([]byte(id))
	if binary.BigEndian.Uint64(sum[:8])%100 < holdoutPercent {
		return SplitHoldout
	}
	return SplitDev
}

// ParseSplit checks the --split flag value.
func ParseSplit(s string) (Split, error) {
	switch Split(s) {
	case SplitDev, SplitHoldout:
		return Split(s), nil
	}
	return "", fmt.Errorf("eval: --split %q must be dev or holdout", s)
}

// FilterMatrix returns the samples of m that sit in split. Fixtures left with no ticket drop out.
func FilterMatrix(m Matrix, split Split) Matrix {
	var out Matrix
	for _, f := range m.Fixtures {
		kept := f
		kept.Tickets = nil
		for _, ft := range f.Tickets {
			if SplitOf(SampleID(f.Name, ft.ID)) == split {
				kept.Tickets = append(kept.Tickets, ft)
			}
		}
		if len(kept.Tickets) > 0 {
			out.Fixtures = append(out.Fixtures, kept)
		}
	}
	return out
}

// SplitReport prints the pass rate of each split side by side. It counts preset-arm tickets only,
// and puts each ticket in its split by hash, so it reads a scorecard from any run.
func SplitReport(sc Scorecard) string {
	rows := map[Split]Aggregate{}
	rs := sc.Tickets
	if preset := presetOnly(rs); len(preset) > 0 {
		rs = preset
	}
	for _, split := range []Split{SplitDev, SplitHoldout} {
		var in []TicketResult
		for _, r := range rs {
			if SplitOf(SampleID(r.Fixture, r.Ticket)) == split {
				in = append(in, r)
			}
		}
		rows[split] = aggregate(in)
	}
	var b strings.Builder
	b.WriteString("| Split | Samples | Merged | Pass rate |\n|---|---|---|---|\n")
	for _, split := range []Split{SplitDev, SplitHoldout} {
		a := rows[split]
		rate := "-"
		if a.Total > 0 {
			rate = fmt.Sprintf("%.2f", a.PassRate)
		}
		fmt.Fprintf(&b, "| %s | %d | %d | %s |\n", split, a.Total, a.Merged, rate)
	}
	return b.String()
}

func newSplitsCommand() *cobra.Command {
	return &cobra.Command{
		Use:           "splits <scorecard.json>...",
		Short:         "Print pass rate per split, dev and holdout side by side",
		Long:          "Reads one or more scorecards, puts each ticket in dev or holdout by the hash of its sample id, and prints both pass rates in one table.",
		Args:          cobra.MinimumNArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			var all Scorecard
			for _, p := range args {
				sc, err := readScorecard(p)
				if err != nil {
					return err
				}
				all.Tickets = append(all.Tickets, sc.Tickets...)
			}
			_, err := fmt.Fprint(cmd.OutOrStdout(), SplitReport(all))
			return err
		},
	}
}
