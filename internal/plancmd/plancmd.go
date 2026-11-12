// Package plancmd is `factory plan`: it turns a goal, an epic or a spec into a ticket DAG, prints the
// waves, and with --approve files the tickets. Approval is the one human gate before work starts.
package plancmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/plan"
	"github.com/KaaS-team/factory/internal/plan/intent"
)

// Filer is the narrow write port the command needs; api.Tracker has no way to create a ticket.
type Filer interface {
	// Find returns the id of an existing ticket with this title.
	Find(ctx context.Context, title string) (api.TicketID, bool, error)
	// Create files one ticket and returns its id.
	Create(ctx context.Context, t api.Ticket) (api.TicketID, error)
}

// SpecFunc turns a goal into spec text; it is the model step.
type SpecFunc func(ctx context.Context, goal string) (string, error)

// EpicFunc returns the body of epic issue n.
type EpicFunc func(ctx context.Context, n int) (string, error)

// ErrNoSpecSource is returned by the default SpecFunc until the agent runner is wired.
var ErrNoSpecSource = errors.New("drafting a spec from a goal needs the agent runner, which is not wired yet; pass --spec <file>")

// Option configures NewCommand.
type Option func(*deps)

type deps struct {
	spec  SpecFunc
	epic  EpicFunc
	filer Filer
}

// WithSpecFunc sets the model step that drafts spec text from a goal.
func WithSpecFunc(f SpecFunc) Option { return func(d *deps) { d.spec = f } }

// WithEpic sets how `--epic <n>` reads the epic body.
func WithEpic(f EpicFunc) Option { return func(d *deps) { d.epic = f } }

// WithFiler sets where --approve files tickets.
func WithFiler(f Filer) Option { return func(d *deps) { d.filer = f } }

// TicketJSON is one ticket in the printed DAG.
type TicketJSON struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Files   []string `json:"files"`
	Depends []string `json:"depends"`
}

// DAG is what --json prints: the tickets, their waves and any problems.
type DAG struct {
	Spec     string       `json:"spec"`
	Tickets  []TicketJSON `json:"tickets"`
	Waves    [][]string   `json:"waves"`
	Problems []string     `json:"problems"`
}

// NewCommand returns `factory plan "<goal>" | --epic <n> | --spec <file>` with --approve and --json.
func NewCommand(opts ...Option) *cobra.Command {
	d := &deps{spec: func(context.Context, string) (string, error) { return "", ErrNoSpecSource }}
	for _, o := range opts {
		o(d)
	}
	var specFile string
	var epic int
	var approve, asJSON bool
	c := &cobra.Command{
		Use:   "plan [goal]",
		Short: "Turn a goal, epic or spec into a ticket DAG; --approve files it",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			text, slug, err := source(ctx, d, args, specFile, epic)
			if err != nil {
				return err
			}
			res, problems, err := build(ctx, text, slug)
			if err != nil {
				return err
			}
			if err := render(cmd.OutOrStdout(), res, problems, asJSON); err != nil {
				return err
			}
			if !approve {
				return nil
			}
			if len(problems) > 0 {
				return errors.New("refusing to file: the plan has problems")
			}
			if d.filer == nil {
				return errors.New("--approve needs a tracker to file into")
			}
			return file(ctx, cmd.OutOrStdout(), d.filer, res.Plan, res.Waves)
		},
	}
	c.Flags().StringVar(&specFile, "spec", "", "read the spec and tickets from `file`")
	c.Flags().IntVar(&epic, "epic", 0, "read the spec and tickets from epic issue `n`")
	c.Flags().BoolVar(&approve, "approve", false, "file the tickets; without it nothing is written")
	c.Flags().BoolVar(&asJSON, "json", false, "print the DAG as JSON")
	return c
}

func source(ctx context.Context, d *deps, args []string, specFile string, epic int) (text, slug string, err error) {
	n := len(args)
	if specFile != "" {
		n++
	}
	if epic != 0 {
		n++
	}
	if n != 1 {
		return "", "", errors.New("give exactly one of a goal, --epic or --spec")
	}
	switch {
	case specFile != "":
		b, err := os.ReadFile(specFile)
		if err != nil {
			return "", "", err
		}
		return string(b), slugOf(specFile), nil
	case epic != 0:
		if d.epic == nil {
			return "", "", errors.New("--epic needs a tracker; pass --spec until one is wired")
		}
		text, err = d.epic(ctx, epic)
		return text, "01-epic-" + strconv.Itoa(epic), err
	}
	text, err = d.spec(ctx, args[0])
	return text, "01-goal", err
}

var slugRe = regexp.MustCompile(`^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$`)

// slugOf turns a spec file name into an NN-words slug, prefixing 01- when the stem lacks a number.
func slugOf(path string) string {
	stem := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if slugRe.MatchString(stem) {
		return stem
	}
	words := strings.Trim(regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(stem), "-"), "-")
	if words == "" {
		words = "spec"
	}
	return "01-" + words
}

// fixed is the Drafter over text that already holds a spec and its tickets. Tickets follow the spec,
// each opened by a line "--- ticket <key>: <title>" and holding a planned body v1.
type fixed struct {
	slug, text string
}

const ticketMark = "--- ticket "

func (f fixed) split() (spec string, tickets []intent.Draft) {
	text := f.text
	if strings.HasPrefix(text, ticketMark) {
		text = "\n" + text
	}
	spec, rest, found := strings.Cut(text, "\n"+ticketMark)
	if !found {
		return f.text, nil
	}
	for _, blk := range strings.Split(rest, "\n"+ticketMark) {
		head, body, _ := strings.Cut(blk, "\n")
		key, title, _ := strings.Cut(head, ":")
		tickets = append(tickets, intent.Draft{Key: strings.TrimSpace(key), Title: strings.TrimSpace(title), Body: body})
	}
	return spec, tickets
}

func (f fixed) Spec(context.Context, string) (intent.Spec, error) {
	s, _ := f.split()
	return intent.Spec{Slug: f.slug, Markdown: s}, nil
}

func (f fixed) Tickets(context.Context, intent.Spec) ([]intent.Draft, error) {
	_, t := f.split()
	return t, nil
}

// build runs the DAG through intent; a rejected draft comes back as problems, not an error.
func build(ctx context.Context, text, slug string) (intent.Result, []string, error) {
	res, err := intent.Run(ctx, fixed{slug: slug, text: text}, "plan")
	var pe *intent.ProblemsError
	if errors.As(err, &pe) {
		return res, pe.Problems, nil
	}
	return res, nil, err
}

func render(w io.Writer, res intent.Result, problems []string, asJSON bool) error {
	by := map[string]plan.Ticket{}
	for _, t := range res.Plan.Tickets {
		by[t.ID] = t
	}
	if asJSON {
		dag := DAG{Spec: res.Spec.Slug, Waves: res.Waves, Problems: problems}
		if dag.Problems == nil {
			dag.Problems = []string{}
		}
		for _, t := range res.Plan.Tickets {
			dag.Tickets = append(dag.Tickets, TicketJSON{ID: t.ID, Title: t.Title, Files: t.Files, Depends: t.Depends})
		}
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(dag)
	}
	for i, wave := range res.Waves {
		say(w, "Wave %d:\n", i+1)
		for _, id := range wave {
			t := by[id]
			say(w, "  %s  %s\n      Files: %s\n", t.ID, t.Title, strings.Join(t.Files, ", "))
		}
	}
	if len(problems) > 0 {
		say(w, "Problems:\n")
		for _, p := range problems {
			say(w, "  - %s\n", p)
		}
	}
	return nil
}

// file creates each ticket once, dependencies first, skipping titles the tracker already has.
func file(ctx context.Context, w io.Writer, f Filer, p plan.Plan, waves [][]string) error {
	by := map[string]plan.Ticket{}
	for _, t := range p.Tickets {
		by[t.ID] = t
	}
	ids := map[string]api.TicketID{}
	for _, wave := range waves {
		for _, key := range wave {
			t := by[key]
			if id, ok, err := f.Find(ctx, t.Title); err != nil {
				return err
			} else if ok {
				ids[key] = id
				say(w, "exists #%s %s\n", id, t.Title)
				continue
			}
			at := api.Ticket{Title: t.Title, Files: t.Files}
			var refs []string
			for _, dep := range t.Depends {
				at.BlockedBy = append(at.BlockedBy, ids[dep])
				refs = append(refs, "#"+string(ids[dep]))
			}
			at.Body = strings.TrimRight(t.Body.Render(), "\n") + "\n\nFiles: " + strings.Join(t.Files, ", ") + "\n"
			if len(refs) > 0 {
				at.Body += "Blocked by: " + strings.Join(refs, ", ") + "\n"
			}
			id, err := f.Create(ctx, at)
			if err != nil {
				return fmt.Errorf("filing %s: %w", key, err)
			}
			ids[key] = id
			say(w, "filed #%s %s\n", id, t.Title)
		}
	}
	return nil
}

// say writes to a command's output; a failed write to the terminal has nowhere useful to go.
func say(w io.Writer, format string, a ...any) { _, _ = fmt.Fprintf(w, format, a...) }
