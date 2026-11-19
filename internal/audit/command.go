package audit

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"
)

// DefaultDir is where audit files live, relative to the repo.
const DefaultDir = ".factory/audit"

// Dir is the audit directory: FACTORY_AUDIT_DIR, or DefaultDir.
func Dir() string {
	if d := os.Getenv("FACTORY_AUDIT_DIR"); d != "" {
		return d
	}
	return DefaultDir
}

// Install makes the process record to Dir() and, when OTEL_EXPORTER_OTLP_ENDPOINT is set, to
// that collector. The returned function flushes the collector queue; call it before exit.
func Install(ctx context.Context) (flush func()) {
	sinks := Multi{&File{Dir: Dir()}}
	o, err := NewOTLPFromEnv(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "audit: otlp export off:", err)
	}
	if o != nil {
		sinks = append(sinks, o)
	}
	restore := SetSink(sinks)
	return func() {
		if o != nil {
			c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = o.Close(c)
		}
		restore()
	}
}

// NewCommand returns `factory audit`.
func NewCommand() *cobra.Command {
	root := &cobra.Command{Use: "audit", Short: "Read the audit log of what the factory did"}
	var since, format string
	export := &cobra.Command{
		Use:   "export",
		Short: "Print audit records from the last --since, as jsonl or csv",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			d, err := ParseSince(since)
			if err != nil {
				return err
			}
			return Export(Dir(), now().Add(-d), format, c.OutOrStdout())
		},
	}
	export.Flags().StringVar(&since, "since", "7d", "how far back to read, such as 7d or 12h")
	export.Flags().StringVar(&format, "format", "jsonl", "jsonl or csv")
	root.AddCommand(export)
	return root
}
