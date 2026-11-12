// Ported from ast-grep/ast-grep@c7e005c crates/config/src/rule_config.rs (field list of SerializableRuleConfig only)
// and crates/cli/src/verify/reporter.rs (the PASS/FAIL/SKIP summary line, read by Eval).

package astgrep

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Rule is the top level of one ast-grep rule file. Keys beyond the nine the check pack reads are
// kept so valid ast-grep rules still load; unknown keys are rejected as ast-grep rejects them.
type Rule struct {
	ID       string   `yaml:"id"`
	Language string   `yaml:"language"`
	Rule     any      `yaml:"rule"`
	Fix      any      `yaml:"fix"`
	Severity Severity `yaml:"severity"`
	Files    []string `yaml:"files"`
	Ignores  []string `yaml:"ignores"`
	Message  string   `yaml:"message"`
	Note     string   `yaml:"note"`

	Constraints any    `yaml:"constraints"`
	Utils       any    `yaml:"utils"`
	Transform   any    `yaml:"transform"`
	Rewriters   any    `yaml:"rewriters"`
	Labels      any    `yaml:"labels"`
	URL         string `yaml:"url"`
	Metadata    any    `yaml:"metadata"`
}

// Pack is a directory of rule files under rules/ with their tests under rule-tests/, run through sgconfig.yml.
type Pack struct {
	Dir   string
	Rules []Rule
}

// LoadPack reads every rule in dir/rules and checks the fields a rule needs.
func LoadPack(dir string) (*Pack, error) {
	files, err := filepath.Glob(filepath.Join(dir, "rules", "*.y*ml"))
	if err != nil {
		return nil, err
	}
	p := &Pack{Dir: dir}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		dec := yaml.NewDecoder(bytes.NewReader(b))
		dec.KnownFields(true)
		for {
			var r Rule
			if err := dec.Decode(&r); errors.Is(err, io.EOF) {
				break
			} else if err != nil {
				return nil, fmt.Errorf("%s: %w", f, err)
			}
			if err := r.check(); err != nil {
				return nil, fmt.Errorf("%s: %w", f, err)
			}
			p.Rules = append(p.Rules, r)
		}
	}
	if len(p.Rules) == 0 {
		return nil, fmt.Errorf("%s: no rules under rules/", dir)
	}
	return p, nil
}

func (r *Rule) check() error {
	switch {
	case r.ID == "":
		return errors.New("rule has no id")
	case r.Language == "":
		return fmt.Errorf("rule %s has no language", r.ID)
	case r.Rule == nil:
		return fmt.Errorf("rule %s has no rule", r.ID)
	}
	switch r.Severity {
	case "", SeverityOff, SeverityHint, SeverityInfo, SeverityWarning, SeverityError:
		return nil
	}
	return fmt.Errorf("rule %s: severity %q is not one of off, hint, info, warning, error", r.ID, r.Severity)
}

// Scorecard says how many of a pack's rules passed their tests.
type Scorecard struct {
	Passed, Total int
	// Failed lists the rule ids that failed, had no tests or were not reported, sorted.
	Failed []string
}

// String is the scorecard line: "rules passed 2/3".
func (s Scorecard) String() string { return fmt.Sprintf("rules passed %d/%d", s.Passed, s.Total) }

// Rate is Passed over Total, zero for an empty pack.
func (s Scorecard) Rate() float64 {
	if s.Total == 0 {
		return 0
	}
	return float64(s.Passed) / float64(s.Total)
}

// Eval runs `ast-grep test` in the pack and scores each rule by its PASS line. A rule with no PASS
// line (FAIL, SKIP or absent) is failed. Output with no summary lines and a non-zero exit is a *RuleLoadError.
func Eval(ctx context.Context, r Runner, dir string, p *Pack) (Scorecard, error) {
	res, err := r.Run(ctx, dir, []string{"test", "--config", "sgconfig.yml"})
	if err != nil {
		return Scorecard{}, err
	}
	pass := map[string]bool{}
	seen := false
	for _, line := range strings.Split(string(res.Stdout), "\n") {
		verb, rest, ok := strings.Cut(line, " ")
		if !ok || (verb != "PASS" && verb != "FAIL" && verb != "SKIP") {
			continue
		}
		seen = true
		if id := strings.Fields(rest); len(id) > 0 && verb == "PASS" {
			pass[id[0]] = true
		}
	}
	if !seen && res.Exit != 0 {
		return Scorecard{}, &RuleLoadError{Stderr: string(res.Stderr)}
	}
	sc := Scorecard{Total: len(p.Rules)}
	for _, rule := range p.Rules {
		if pass[rule.ID] {
			sc.Passed++
		} else {
			sc.Failed = append(sc.Failed, rule.ID)
		}
	}
	sort.Strings(sc.Failed)
	return sc, nil
}
