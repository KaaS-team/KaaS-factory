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
	runner  func(ctx context.Context, workflow, agent, format string) (Deps, error)
	control func(ctx context.Context, agent string) (BareModel, BareShell, error)
	now     func() time.Time
}

// WithRunner sets how the command builds the Deps that run one workflow with one agent preset.
// Without it `eval` runs each ticket through the local dispatcher; tests pass a fake.
func WithRunner(f func(ctx context.Context, workflow, agent, format string) (Deps, error)) Option {
	return func(o *options) { o.runner = f }
}

// WithControl sets how the command builds the model and shell of the bare-bash control arm.
// Without it `--arm control` fails; tests pass fakes.
func WithControl(f func(ctx context.Context, agent string) (BareModel, BareShell, error)) Option {
	return func(o *options) { o.control = f }
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
	var workflow, agent, format, packs, fixtures, outDir, runDir string
	var arms []string
	var tries int
	var replay, redo bool
	cmd := &cobra.Command{
		Use:           "eval",
		Short:         "Run the fixtures matrix and write a scorecard",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if tries < 1 {
				return fmt.Errorf("eval: --tries %d must be at least 1", tries)
			}
			if (replay || redo) && runDir == "" {
				return errors.New("eval: --replay and --redo need --run-dir")
			}
			checked := map[string]string{"workflow": workflow, "agent": agent}
			if format != "" {
				checked["format"] = format
			}
			for _, a := range arms {
				if a != "preset" && a != "control" {
					return fmt.Errorf("eval: --arm %q must be preset or control", a)
				}
			}
			for flag, v := range checked {
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
				run = func(ctx context.Context, workflow, agent, _ string) (Deps, error) {
					armWork, err := os.MkdirTemp(work, "arm-") // each arm builds its fixture repos apart
					if err != nil {
						return nil, err
					}
					return NewLocalDeps(ctx, LocalConfig{Fixtures: fixtures, Agent: agent, Workflow: workflow, Work: armWork})
				}
			}
			var store *RunStore
			if runDir != "" {
				if store, err = OpenRunStore(runDir); err != nil {
					return err
				}
			}
			sc := Scorecard{Schema: SchemaV1, Tries: tries}
			for _, arm := range arms {
				deps, err := run(cmd.Context(), workflow, agent, format)
				if err != nil {
					return err
				}
				if arm == "control" {
					if o.control == nil {
						return errors.New("eval: no control model configured")
					}
					model, shell, err := o.control(cmd.Context(), agent)
					if err != nil {
						return err
					}
					deps = controlDeps{Deps: deps, model: model, shell: shell}
				}
				part, err := RunArm(cmd.Context(), m, deps, Arm{Arm: arm, Agent: agent, Format: format, Tries: tries, Store: store, Replay: replay, Redo: redo})
				if err != nil {
					return err
				}
				sc.Tickets = append(sc.Tickets, part.Tickets...)
				sc.Cells = append(sc.Cells, part.Cells...)
			}
			sc.Aggregate = aggregate(sc.Tickets)
			if preset := presetOnly(sc.Tickets); len(preset) > 0 {
				sc.Aggregate = aggregate(preset) // the control arm is a baseline, not part of the headline
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
	cmd.Flags().StringVar(&format, "format", "", "edit format axis, e.g. diff or whole")
	cmd.Flags().StringSliceVar(&arms, "arm", []string{"preset"}, "arms to run: preset, control (bare-bash baseline)")
	cmd.Flags().IntVar(&tries, "tries", 1, "tries per ticket; the scorecard gets pass_rate_1..N")
	cmd.Flags().StringVar(&runDir, "run-dir", "", "keep results and trajectories here so a killed run resumes")
	cmd.Flags().BoolVar(&replay, "replay", false, "re-score the outputs stored in --run-dir without dispatching")
	cmd.Flags().BoolVar(&redo, "redo", false, "rerun tickets --run-dir already finished")
	cmd.Flags().StringVar(&packs, "packs", "", "packs lock file the run used, e.g. factory.lock")
	cmd.Flags().StringVar(&fixtures, "fixtures", "evals/fixtures", "directory of fixtures")
	cmd.Flags().StringVar(&outDir, "out", "evals", "directory the scorecard is written to")
	cmd.AddCommand(newDiffCommand(), newCheckCommand())
	return cmd
}

func presetOnly(rs []TicketResult) []TicketResult {
	var out []TicketResult
	for _, r := range rs {
		if r.Arm != "control" {
			out = append(out, r)
		}
	}
	return out
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
			b.WriteString(cellDiff(oldSC.Cells, newSC.Cells))
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

// cellDiff lists pass_rate_1 and malformed count per cell present in both scorecards.
func cellDiff(oldCells, newCells []Cell) string {
	prev := map[string]Cell{}
	for _, c := range oldCells {
		prev[c.Key()] = c
	}
	var b strings.Builder
	for _, n := range newCells {
		o, ok := prev[n.Key()]
		if !ok || len(o.PassRates) == 0 || len(n.PassRates) == 0 {
			continue
		}
		if b.Len() == 0 {
			b.WriteString("\n| cell | pass_rate_1 old | new | delta | malformed old | new |\n|---|---|---|---|---|---|\n")
		}
		fmt.Fprintf(&b, "| %s | %.2f | %.2f | %+.2f | %d | %d |\n", n.Key(), o.PassRates[0], n.PassRates[0], n.PassRates[0]-o.PassRates[0], o.Malformed, n.Malformed)
	}
	return b.String()
}
