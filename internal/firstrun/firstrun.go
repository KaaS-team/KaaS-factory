// Package firstrun is the first-hour demo: it runs the auditor, maps each finding to a catalogue
// pack, sizes the fixes and writes a scorecard. Run dispatches nothing; Execute dispatches the first fix.
package firstrun

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/KaaS-team/factory/internal/api"
)

//go:embed catalogue.yaml
var catalogueYAML []byte

// Finding is one auditor finding.
type Finding struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Severity  string `json:"severity"`
	File      string `json:"file"`
	Line      int    `json:"line"`
	RiskArea  string `json:"risk_area"`
	Pack      string `json:"pack"`
	Effort    string `json:"effort"`
	ScoreGain int    `json:"score_gain"`
}

// Schema is the auditor report contract first-run reads (auditor docs/json.md).
const Schema = "auditor.report/v1"

// Audit is the part of `auditor report --json` (auditor.report/v1) that first-run reads.
type Audit struct {
	Schema string `json:"schema"`
	Scores struct {
		Overall int `json:"overall"`
	} `json:"scores"`
	TopRisks []Finding `json:"top_risks"`
	Findings []Finding `json:"findings"`
}

// Prior is the fixed estimate for one size.
type Prior struct {
	Tokens  int `yaml:"tokens"`
	Minutes int `yaml:"minutes"`
}

// Catalogue is the data file catalogue.yaml.
type Catalogue struct {
	Auditor struct {
		Binary  string `yaml:"binary"`
		Install string `yaml:"install"`
	} `yaml:"auditor"`
	Priors map[string]Prior `yaml:"priors"`
}

// LoadCatalogue parses the embedded catalogue.yaml.
func LoadCatalogue() (Catalogue, error) {
	var c Catalogue
	if err := yaml.Unmarshal(catalogueYAML, &c); err != nil {
		return c, fmt.Errorf("catalogue.yaml: %w", err)
	}
	return c, nil
}

// Options configures Run.
type Options struct {
	DryRun bool
	// GH is an owner/repo to audit through the auditor's GitHub mode; empty skips it.
	GH string
	// Dir is the repository to audit; empty means the current directory.
	Dir string
	// Dispatcher is held so callers can prove Run never uses it.
	Dispatcher api.Dispatcher
	// Catalogue overrides the embedded data; nil uses it.
	Catalogue *Catalogue
}

// Row is one line of the "What the factory would fix" table.
type Row struct {
	Finding    Finding
	Pack       string
	Size       string
	Risk       string
	Tokens     int
	Minutes    int
	ScoreAfter int
}

// Report is the scorecard.
type Report struct {
	Score      int
	TopRisks   []Finding
	Rows       []Row
	NotCovered []Finding
	ScoreAfter int
	// First is the row to fix first; nil when nothing is covered.
	First *Row
	// Command is the command that approves First; empty when First is nil or on a dry run.
	Command string
	DryRun  bool
}

// Run audits, maps, sizes and projects. It never calls a Dispatcher.
func Run(ctx context.Context, o Options) (Report, error) {
	cat := o.Catalogue
	if cat == nil {
		c, err := LoadCatalogue()
		if err != nil {
			return Report{}, err
		}
		cat = &c
	}
	bin, err := exec.LookPath(cat.Auditor.Binary)
	if err != nil {
		return Report{}, fmt.Errorf("auditor binary %q not found on PATH; install it with: %s", cat.Auditor.Binary, cat.Auditor.Install)
	}
	dir := o.Dir
	if dir == "" {
		dir = "."
	}
	a, err := runAudit(ctx, bin, o.Dir, "report", "--json", dir)
	if err != nil {
		return Report{}, err
	}
	if a.Schema != Schema {
		return Report{}, fmt.Errorf("auditor report schema %q, want %q; upgrade the auditor", a.Schema, Schema)
	}
	if o.GH != "" {
		g, err := runAudit(ctx, bin, o.Dir, "audit", "--json", "--gh", o.GH, dir)
		if err != nil {
			return Report{}, err
		}
		a = merge(a, g)
	}
	r := Build(a, *cat)
	r.DryRun = o.DryRun
	r.First = Pick(r.Rows)
	if r.First != nil && !o.DryRun {
		r.Command = "factory approve first-run " + r.First.Finding.ID
	}
	return r, nil
}

func runAudit(ctx context.Context, bin, dir string, args ...string) (Audit, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return Audit{}, fmt.Errorf("auditor %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	var a Audit
	if err := json.Unmarshal(out.Bytes(), &a); err != nil {
		return Audit{}, fmt.Errorf("auditor output is not valid JSON: %w", err)
	}
	return a, nil
}

// merge adds findings of b that a lacks, keeping a's score and top risks.
func merge(a, b Audit) Audit {
	seen := map[string]bool{}
	for _, f := range a.Findings {
		seen[f.ID+"|"+f.File] = true
	}
	for _, f := range b.Findings {
		if !seen[f.ID+"|"+f.File] {
			a.Findings = append(a.Findings, f)
		}
	}
	if len(a.TopRisks) == 0 {
		a.TopRisks = b.TopRisks
	}
	return a
}

// Build maps findings to packs and projects the after-score. It is pure.
func Build(a Audit, cat Catalogue) Report {
	score := a.Scores.Overall
	r := Report{Score: score, TopRisks: a.TopRisks}
	if len(r.TopRisks) > 3 {
		r.TopRisks = r.TopRisks[:3]
	}
	total := 0
	for _, f := range a.Findings {
		if f.Severity == "ok" {
			continue
		}
		p, ok := cat.Priors[f.Effort]
		if f.Pack == "" || !ok {
			r.NotCovered = append(r.NotCovered, f)
			continue
		}
		total += f.ScoreGain
		r.Rows = append(r.Rows, Row{Finding: f, Pack: f.Pack, Size: f.Effort, Risk: fixRisk(f.RiskArea),
			Tokens: p.Tokens, Minutes: p.Minutes, ScoreAfter: clamp(score + f.ScoreGain)})
	}
	r.ScoreAfter = clamp(score + total)
	return r
}

func clamp(n int) int { return min(n, 100) }

// fixRisk is the risk of changing code for a finding: high inside a risk area the auditor names
// (auth, payments, migrations, db, infra, secrets), low outside one.
func fixRisk(area string) string {
	if area == "" || area == "none" {
		return "low"
	}
	return "high"
}

var riskRank = map[string]int{"low": 0, "medium": 1, "high": 2}

// Pick returns the row to fix first: lowest fix risk, then highest score gain, then finding id.
// An unknown risk ranks after high. It returns nil for no rows.
func Pick(rows []Row) *Row {
	if len(rows) == 0 {
		return nil
	}
	rank := func(s string) int {
		if v, ok := riskRank[s]; ok {
			return v
		}
		return len(riskRank)
	}
	s := append([]Row(nil), rows...)
	sort.SliceStable(s, func(i, j int) bool {
		a, b := s[i], s[j]
		if rank(a.Risk) != rank(b.Risk) {
			return rank(a.Risk) < rank(b.Risk)
		}
		if a.Finding.ScoreGain != b.Finding.ScoreGain {
			return a.Finding.ScoreGain > b.Finding.ScoreGain
		}
		return a.Finding.ID < b.Finding.ID
	})
	return &s[0]
}

var errNoReport = errors.New("firstrun: empty report")

// Markdown renders the operator report. Estimates appear only here.
func (r Report) Markdown() (string, error) {
	if r.Score == 0 && len(r.Rows) == 0 && len(r.NotCovered) == 0 && len(r.TopRisks) == 0 {
		return "", errNoReport
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# Factory first-run scorecard\n\nScore now: %d. Projected after the fixes below: %d.\n\n", r.Score, r.ScoreAfter)
	b.WriteString("## Top 3 risks\n\n")
	for i, f := range r.TopRisks {
		fmt.Fprintf(&b, "%d. %s (%s)\n", i+1, f.Title, loc(f))
	}
	b.WriteString("\n## What the factory would fix\n\n| Finding | Pack | Size | Estimate | Score after |\n|---|---|---|---|---|\n")
	for _, w := range r.Rows {
		fmt.Fprintf(&b, "| %s (%s) | %s | %s | ~%dk tokens, ~%d min | %d |\n", w.Finding.ID, loc(w.Finding), w.Pack, w.Size, w.Tokens/1000, w.Minutes, w.ScoreAfter)
	}
	if len(r.NotCovered) > 0 {
		b.WriteString("\n## Not covered\n\n")
		for _, f := range r.NotCovered {
			fmt.Fprintf(&b, "- %s (%s)\n", f.ID, loc(f))
		}
	}
	b.WriteString("\n## 30/60/90\n\n")
	for _, p := range []struct{ label, size string }{{"30 days", "S"}, {"60 days", "M"}, {"90 days", "L"}} {
		fmt.Fprintf(&b, "- %s:", p.label)
		n := 0
		for _, w := range r.Rows {
			if w.Size == p.size {
				fmt.Fprintf(&b, " %s", w.Pack)
				n++
			}
		}
		if n == 0 {
			b.WriteString(" nothing")
		}
		b.WriteString("\n")
	}
	if r.First != nil && r.DryRun {
		fmt.Fprintf(&b, "\n## First fix\n\nWould dispatch one build for %s with pack %s. Nothing was dispatched.\n", r.First.Finding.ID, r.First.Pack)
	} else if r.First != nil {
		fmt.Fprintf(&b, "\n## First fix\n\n%s with pack %s. Approve it with:\n\n    %s\n", r.First.Finding.ID, r.First.Pack, r.Command)
	}
	return b.String(), nil
}

func loc(f Finding) string {
	if f.File == "" {
		return "repo-wide"
	}
	if f.Line > 0 {
		return fmt.Sprintf("%s:%d", f.File, f.Line)
	}
	return f.File
}
