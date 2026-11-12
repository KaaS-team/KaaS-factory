package report

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// Option configures NewCommand.
type Option func(*options)

type options struct {
	source func(context.Context) (Source, error)
	now    func() time.Time
}

// WithSource sets how the command opens its Source. Without it the command fails.
func WithSource(f func(context.Context) (Source, error)) Option {
	return func(o *options) { o.source = f }
}

// WithNow sets the clock the --since window is measured from.
func WithNow(f func() time.Time) Option { return func(o *options) { o.now = f } }

var prBodyName = regexp.MustCompile(`(?i)^(pr[-_]?body|pull[-_]request[-_]template)`)

// checkOut refuses an --out path under .github/ or named like a PR body file. The report holds
// token and cost figures that must never reach a customer-facing page.
func checkOut(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	// Resolve symlinks in the deepest existing parent so a link cannot hide a .github directory.
	dir := filepath.Dir(abs)
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	full := filepath.Join(dir, filepath.Base(abs))
	for _, seg := range strings.Split(filepath.ToSlash(abs)+"/"+filepath.ToSlash(full), "/") {
		if strings.EqualFold(seg, ".github") {
			return fmt.Errorf("report is operator-only: refusing to write %s under .github/", path)
		}
	}
	if prBodyName.MatchString(filepath.Base(abs)) {
		return fmt.Errorf("report is operator-only: refusing to write %s, it looks like a PR body file", path)
	}
	return nil
}

// parseSince reads "7d", "36h" or any time.ParseDuration string; it must be positive.
func parseSince(s string) (time.Duration, error) {
	var d time.Duration
	if n, ok := strings.CutSuffix(s, "d"); ok {
		days, err := strconv.Atoi(n)
		if err != nil {
			return 0, fmt.Errorf("report: bad --since %q", s)
		}
		d = time.Duration(days) * 24 * time.Hour
	} else {
		var err error
		if d, err = time.ParseDuration(s); err != nil {
			return 0, fmt.Errorf("report: bad --since %q", s)
		}
	}
	if d <= 0 {
		return 0, fmt.Errorf("report: --since %q must be positive", s)
	}
	return d, nil
}

// NewCommand returns `factory report [--since 7d] [--json] [--by team|workflow|pack] [--out path]`.
func NewCommand(opts ...Option) *cobra.Command {
	o := options{now: time.Now}
	for _, f := range opts {
		f(&o)
	}
	var since, by, out string
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "report",
		Short: "Show tokens per merged PR, rework, human touches and cycle time (operator only)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			g := GroupBy(by)
			if g != ByTeam && g != ByWorkflow && g != ByPack {
				return fmt.Errorf("report: --by must be team, workflow or pack, not %q", by)
			}
			d, err := parseSince(since)
			if err != nil {
				return err
			}
			if out != "" {
				if err := checkOut(out); err != nil {
					return err
				}
			}
			if o.source == nil {
				return errors.New("report: no ticket source configured")
			}
			src, err := o.source(cmd.Context())
			if err != nil {
				return err
			}
			now := o.now()
			rep, err := Build(cmd.Context(), src, Window{Since: now.Add(-d), Until: now})
			if err != nil {
				return err
			}
			var buf bytes.Buffer
			if asJSON {
				err = WriteJSON(&buf, rep, g)
			} else {
				err = WriteMarkdown(&buf, rep, g)
			}
			if err != nil {
				return err
			}
			if out != "" {
				return os.WriteFile(out, buf.Bytes(), 0o600)
			}
			_, err = cmd.OutOrStdout().Write(buf.Bytes())
			return err
		},
	}
	cmd.Flags().StringVar(&since, "since", "7d", "window length ending now, such as 7d or 36h")
	cmd.Flags().BoolVar(&asJSON, "json", false, "write JSON instead of markdown")
	cmd.Flags().StringVar(&by, "by", "team", "group rows by team, workflow or pack")
	cmd.Flags().StringVar(&out, "out", "", "write the report to this file; never under .github/ or a PR body file")
	return cmd
}
