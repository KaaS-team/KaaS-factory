package eval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// ErrWorse is returned by `eval diff` when the new scorecard is worse than the old one.
var ErrWorse = errors.New("new scorecard is worse")

// Option configures NewCommand.
type Option func(*options)

type options struct {
	runner func(ctx context.Context, workflow, agent string) (Deps, error)
	now    func() time.Time
}

// WithRunner sets how the command builds the Deps that run one workflow with one agent preset.
// Without it `eval` runs each ticket through the local dispatcher; tests pass a fake.
func WithRunner(f func(ctx context.Context, workflow, agent string) (Deps, error)) Option {
	return func(o *options) { o.runner = f }
}

// WithNow sets the clock that names the scorecard file.
func WithNow(f func() time.Time) Option { return func(o *options) { o.now = f } }

var (
	safeName  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
	modelWord = regexp.MustCompile(`(?i)claude-|gpt-|gemini|opus|sonnet|haiku|fable`)
)

// NamesModel reports whether s mentions a model name. Scorecards carry the agent preset name only.
func NamesModel(s string) bool { return modelWord.MatchString(s) }

// NewCommand returns the `eval` command: a run that writes a scorecard, and `eval diff`.
func NewCommand(opts ...Option) *cobra.Command {
	o := options{now: time.Now}
	for _, f := range opts {
		f(&o)
	}
	var workflow, agent, packs, fixtures, outDir string
	cmd := &cobra.Command{
		Use:           "eval",
		Short:         "Run the fixtures matrix and write a scorecard",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			for flag, v := range map[string]string{"workflow": workflow, "agent": agent} {
				if !safeName.MatchString(v) {
					return fmt.Errorf("eval: --%s %q must be lowercase letters, digits, dot, dash or underscore", flag, v)
				}
				if NamesModel(v) {
					return fmt.Errorf("eval: --%s %q names a model; use the preset name", flag, v)
				}
			}
			var lockSum string
			if packs != "" {
				b, err := os.ReadFile(packs)
				if err != nil {
					return fmt.Errorf("eval: read packs lock: %w", err)
				}
				sum := sha256.Sum256(b)
				lockSum = "sha256:" + hex.EncodeToString(sum[:])
			}
			m, err := LoadMatrix(fixtures)
			if err != nil {
				return err
			}
			if len(m.Fixtures) == 0 {
				return fmt.Errorf("eval: no fixtures under %s", fixtures)
			}
			run := o.runner
			if run == nil { // the default runs each ticket through the local dispatcher in a scratch directory
				work, err := os.MkdirTemp("", "factory-eval-")
				if err != nil {
					return err
				}
				defer func() { _ = os.RemoveAll(work) }()
				run = func(ctx context.Context, workflow, agent string) (Deps, error) {
					return NewLocalDeps(ctx, LocalConfig{Fixtures: fixtures, Agent: agent, Workflow: workflow, Work: work})
				}
			}
			deps, err := run(cmd.Context(), workflow, agent)
			if err != nil {
				return err
			}
			sc, err := Run(cmd.Context(), m, deps)
			if err != nil {
				return err
			}
			sc.Workflow, sc.Agent, sc.Packs = workflow, agent, lockSum
			raw, err := json.MarshalIndent(sc, "", "  ")
			if err != nil {
				return err
			}
			if err := os.MkdirAll(outDir, 0o755); err != nil {
				return err
			}
			base := filepath.Join(outDir, fmt.Sprintf("%s-%s-%s", o.now().UTC().Format("2006-01-02"), workflow, agent))
			if err := os.WriteFile(base+".json", append(raw, '\n'), 0o644); err != nil {
				return err
			}
			if err := os.WriteFile(base+".md", []byte(Markdown(sc, false)), 0o644); err != nil {
				return err
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "wrote %s.json and %s.md\n", base, base)
			return err
		},
	}
	cmd.Flags().StringVar(&workflow, "workflow", "", "workflow name (required)")
	cmd.Flags().StringVar(&agent, "agent", "", "agent preset name, never a model name (required)")
	cmd.Flags().StringVar(&packs, "packs", "", "packs lock file the run used, e.g. factory.lock")
	cmd.Flags().StringVar(&fixtures, "fixtures", "evals/fixtures", "directory of fixtures")
	cmd.Flags().StringVar(&outDir, "out", "evals", "directory the scorecard is written to")
	cmd.AddCommand(newDiffCommand(), newCheckCommand())
	return cmd
}

func readScorecard(path string) (Scorecard, error) {
	var sc Scorecard
	b, err := os.ReadFile(path)
	if err != nil {
		return sc, err
	}
	if err := json.Unmarshal(b, &sc); err != nil {
		return sc, fmt.Errorf("%s: %w", path, err)
	}
	if sc.Schema != SchemaV1 {
		return sc, fmt.Errorf("%s: schema %q, want %q", path, sc.Schema, SchemaV1)
	}
	return sc, nil
}

func newDiffCommand() *cobra.Command {
	return &cobra.Command{
		Use:           "diff <old.json> <new.json>",
		Short:         "Compare two scorecards; exit 1 when the new one is worse",
		Long:          "Prints pass rate, main green rate, tokens per merged PR and median wall time with deltas.\nExits 1 when the new scorecard is worse on pass rate or on tokens per merged PR (more than 10% up).",
		Args:          cobra.ExactArgs(2),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			oldSC, err := readScorecard(args[0])
			if err != nil {
				return err
			}
			newSC, err := readScorecard(args[1])
			if err != nil {
				return err
			}
			var b strings.Builder
			b.WriteString(Diff(oldSC, newSC))
			v := Compare(oldSC, newSC, 0)
			if v.Worse {
				fmt.Fprintf(&b, "\nworse: %s\n", v.Reason)
			} else {
				b.WriteString("\nnot worse\n")
			}
			if _, err := fmt.Fprint(cmd.OutOrStdout(), b.String()); err != nil {
				return err
			}
			if v.Worse {
				return ErrWorse
			}
			return nil
		},
	}
}

func newCheckCommand() *cobra.Command {
	var fixtures string
	var fix bool
	cmd := &cobra.Command{
		Use:           "check",
		Short:         "Lint the fixtures; exit 1 when one is malformed",
		Long:          "Checks every fixture for its required file and keys, its seed, and a hidden directory per ticket.\n--fix writes back only what the tree determines: the name and the seed key.",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ps, err := CheckFixtures(fixtures, fix)
			if err != nil {
				return err
			}
			if len(ps) == 0 {
				_, err = fmt.Fprintln(cmd.OutOrStdout(), "ok")
				return err
			}
			for _, p := range ps {
				if _, err := fmt.Fprintln(cmd.OutOrStdout(), p); err != nil {
					return err
				}
			}
			return ErrFixtureProblems
		},
	}
	cmd.Flags().StringVar(&fixtures, "fixtures", "evals/fixtures", "directory of fixtures")
	cmd.Flags().BoolVar(&fix, "fix", false, "write back the data the tree determines")
	return cmd
}
