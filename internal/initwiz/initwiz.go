// Package initwiz is `factory init`: it asks a few questions, or takes flags, and writes
// .factory/factory.yaml from a tier preset. It writes that one file and nothing else.
package initwiz

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	huh "charm.land/huh/v2"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"

	"github.com/KaaS-team/factory/internal/config"
)

// preset is the set of config values one tier writes. Zero fields are omitted from the file.
type preset struct {
	slots      int
	dispatcher string
	approval   string
	batchSize  int
	teamDay    float64
	month      float64
	noAutoPR   bool // regulated: write requester_cannot_approve and auto_merge explicitly
}

var presets = map[string]preset{
	"solo":       {slots: 1, dispatcher: "local", approval: "always"},
	"startup":    {slots: 3, dispatcher: "routines", approval: "on-risk:low"},
	"scaleup":    {slots: 6, dispatcher: "routines", approval: "on-risk:low", batchSize: 4},
	"enterprise": {slots: 6, dispatcher: "routines", approval: "always", teamDay: 250, month: 5000},
	"regulated":  {slots: 3, dispatcher: "routines", approval: "always", noAutoPR: true},
	"oss":        {slots: 2, dispatcher: "local", approval: "always"},
}

// Tiers lists the tier names in the order the form shows them.
func Tiers() []string {
	return []string{"solo", "startup", "scaleup", "enterprise", "regulated", "oss"}
}

// Trackers lists the supported issue trackers in the order the form shows them.
func Trackers() []string { return []string{"github", "linear", "jira"} }

// Dispatchers lists the dispatcher names a user may pick, in the order the form shows them.
func Dispatchers() []string { return []string{"local", "routines", "fire"} }

// Answers is what the wizard collects. Dispatcher and Repo may be empty: the tier's dispatcher
// and no repo key are used then.
type Answers struct {
	Tier, Tracker, Repo, Dispatcher string
}

type file struct {
	Repo                   string   `yaml:"repo,omitempty"`
	Tracker                string   `yaml:"tracker"`
	Approval               string   `yaml:"approval"`
	Dispatcher             string   `yaml:"dispatcher"`
	Slots                  int      `yaml:"slots"`
	MergeMode              string   `yaml:"merge_mode"`
	BatchSize              int      `yaml:"batch_size,omitempty"`
	Budgets                *budgets `yaml:"budgets,omitempty"`
	AutoMerge              *bool    `yaml:"auto_merge,omitempty"`
	RequesterCannotApprove *bool    `yaml:"requester_cannot_approve,omitempty"`
}

type budgets struct {
	TeamDay float64 `yaml:"team_day,omitempty"`
	Month   float64 `yaml:"month,omitempty"`
}

// Render returns the factory.yaml text for a set of answers, or an error for an unknown choice.
func Render(a Answers) ([]byte, error) {
	p, ok := presets[a.Tier]
	if !ok {
		return nil, fmt.Errorf("unknown tier %q (one of %s)", a.Tier, strings.Join(Tiers(), ", "))
	}
	if !slices.Contains(Trackers(), a.Tracker) {
		return nil, fmt.Errorf("unknown tracker %q (one of %s)", a.Tracker, strings.Join(Trackers(), ", "))
	}
	d := a.Dispatcher
	if d == "" {
		d = p.dispatcher
	}
	if !slices.Contains(Dispatchers(), d) {
		return nil, fmt.Errorf("unknown dispatcher %q (one of %s)", d, strings.Join(Dispatchers(), ", "))
	}
	f := file{Repo: a.Repo, Tracker: a.Tracker, Approval: p.approval, Dispatcher: d, Slots: p.slots,
		MergeMode: "queue", BatchSize: p.batchSize}
	if p.teamDay > 0 || p.month > 0 {
		f.Budgets = &budgets{TeamDay: p.teamDay, Month: p.month}
	}
	if p.noAutoPR {
		no, yes := false, true
		f.AutoMerge, f.RequesterCannotApprove = &no, &yes
	}
	return yaml.Marshal(f)
}

var originRE = regexp.MustCompile(`^(?:https?://|ssh://|git://)?(?:[^@/]+@)?[^/:]+[:/]([^/:]+/[^/]+?)(?:\.git)?/?$`)

// RepoFromOrigin returns owner/repo from the origin remote of the git repo at dir, or "" when
// there is no origin or its URL has no owner/repo shape.
func RepoFromOrigin(dir string) string {
	cmd := exec.Command("git", "remote", "get-url", "origin")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	m := originRE.FindStringSubmatch(strings.TrimSpace(string(out)))
	if m == nil {
		return ""
	}
	return m[1]
}

// Write renders a to dir/.factory/factory.yaml. It refuses when a repo config file already exists
// unless force is set.
func Write(dir string, a Answers, force bool) (string, error) {
	data, err := Render(a)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, config.RepoFileYAML)
	if !force {
		for _, name := range []string{config.RepoFileYAML, config.RepoFileJSON} {
			if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
				return "", fmt.Errorf("%s already exists; pass --force to overwrite it", name)
			}
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	return path, os.WriteFile(path, data, 0o644)
}

// Ask runs the form on in and out and fills a. Fields already set in a are the defaults shown.
func Ask(in io.Reader, out io.Writer, accessible bool, a *Answers) error {
	in = oneByte{in} // each form buffers its input; reading a byte at a time leaves the rest for the next form
	run := func(fields ...huh.Field) error {
		return huh.NewForm(huh.NewGroup(fields...)).WithAccessible(accessible).WithInput(in).WithOutput(out).Run()
	}
	if a.Tier == "" {
		a.Tier = Tiers()[0]
	}
	if err := run(huh.NewSelect[string]().Title("Tier").Options(huh.NewOptions(Tiers()...)...).Value(&a.Tier)); err != nil {
		return err
	}
	if a.Tracker == "" {
		a.Tracker = Trackers()[0]
	}
	if a.Dispatcher == "" {
		a.Dispatcher = presets[a.Tier].dispatcher
	}
	return run(
		huh.NewSelect[string]().Title("Tracker").Options(huh.NewOptions(Trackers()...)...).Value(&a.Tracker),
		huh.NewInput().Title("Repo (owner/name)").Value(&a.Repo),
		huh.NewSelect[string]().Title("Dispatcher").Options(huh.NewOptions(Dispatchers()...)...).Value(&a.Dispatcher),
	)
}

// oneByte hands out at most one byte per Read.
type oneByte struct{ r io.Reader }

func (o oneByte) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	return o.r.Read(p[:1])
}

// NewCommand returns `factory init`.
func NewCommand() *cobra.Command {
	var (
		a                      Answers
		dir                    string
		yes, force, accessible bool
	)
	c := &cobra.Command{
		Use:   "init",
		Short: "Write .factory/factory.yaml from a tier preset",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if a.Repo == "" {
				a.Repo = RepoFromOrigin(dir)
			}
			if yes {
				if a.Tier == "" || a.Tracker == "" {
					return errors.New("--yes needs --tier and --tracker")
				}
			} else if err := Ask(cmd.InOrStdin(), cmd.OutOrStdout(), accessible, &a); err != nil {
				return err
			}
			path, err := Write(dir, a, force)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "wrote %s\n", path)
			return err
		},
	}
	f := c.Flags()
	f.BoolVar(&yes, "yes", false, "run without prompts; needs --tier and --tracker")
	f.BoolVar(&force, "force", false, "overwrite an existing .factory/factory.yaml")
	f.BoolVar(&accessible, "accessible", false, "plain numbered prompts instead of the full-screen form")
	f.StringVar(&a.Tier, "tier", "", "tier preset: "+strings.Join(Tiers(), ", "))
	f.StringVar(&a.Tracker, "tracker", "", "tracker: "+strings.Join(Trackers(), ", "))
	f.StringVar(&a.Repo, "repo", "", "owner/name; default from the origin remote")
	f.StringVar(&a.Dispatcher, "dispatcher", "", "dispatcher: "+strings.Join(Dispatchers(), ", ")+"; default from the tier")
	f.StringVar(&dir, "dir", ".", "repo root to write into")
	return c
}
