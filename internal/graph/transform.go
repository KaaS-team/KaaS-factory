package graph

import (
	"context"
	_ "embed" // the vendored rule schema
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"gopkg.in/yaml.v3"
)

// ruleSchema is schemas/rule.json from ast-grep (MIT, github.com/ast-grep/ast-grep@c7e005c), unchanged.
//
//go:embed rule.schema.json
var ruleSchema []byte

// The typed failures of a transform step. Each one sends the workflow back to the authoring step.
var (
	ErrNoRule     = errors.New("transform: the rules dir has no rule file")
	ErrRuleSchema = errors.New("transform: rule does not match the ast-grep schema")
	ErrRulePath   = errors.New("transform: rule id or file leaves the rules dir")
	ErrRuleCases  = errors.New("transform: rule needs a tests file with a valid and an invalid case")
)

// Hit is one place a rule still matches after the apply, for the follow-up ticket.
type Hit struct {
	File string
	Line int
	Rule string
}

// AstGrep is the part of the ast-grep binary the transform step calls. Nothing here calls a model.
type AstGrep interface {
	// Test runs `ast-grep test` over the rules dir; a failing case is an error.
	Test(ctx context.Context, rules string) error
	// Apply runs `ast-grep scan --update-all` with the rules over root.
	Apply(ctx context.Context, rules, root string) error
	// Scan lists the matches the rules still have in root.
	Scan(ctx context.Context, rules, root string) ([]Hit, error)
}

// TransformSpec says where the agent's rules are and which tree to rewrite.
type TransformSpec struct{ Rules, Root string }

// TransformResult is what a passing transform step leaves: the files that go in the PR and what remains.
type TransformResult struct {
	Land     []string // rule, tests and snapshot files, relative to the rules dir
	Residual []Hit
}

// RunTransform checks each rule file against the schema and for valid and invalid cases, runs the rule
// tests, then rewrites the tree. A rule that fails any check is never applied.
func RunTransform(ctx context.Context, ag AstGrep, spec TransformSpec) (TransformResult, error) {
	var res TransformResult
	rules, _ := filepath.Glob(filepath.Join(spec.Rules, "*.yml"))
	sort.Strings(rules)
	if len(rules) == 0 {
		return res, ErrNoRule
	}
	sch, err := compileRuleSchema()
	if err != nil {
		return res, err
	}
	for _, f := range rules {
		id, err := checkRule(sch, f)
		if err != nil {
			return res, err
		}
		if err := regularFile(f); err != nil {
			return res, err
		}
		res.Land = append(res.Land, filepath.Base(f))
		cases := filepath.Join("tests", id+"-test.yml")
		if err := checkCases(filepath.Join(spec.Rules, cases)); err != nil {
			return res, err
		}
		res.Land = append(res.Land, cases)
		if snap := filepath.Join("__snapshots__", id+"-snapshot.yml"); exists(filepath.Join(spec.Rules, snap)) {
			if err := regularFile(filepath.Join(spec.Rules, snap)); err != nil {
				return res, err
			}
			res.Land = append(res.Land, snap)
		}
	}
	if err := ag.Test(ctx, spec.Rules); err != nil {
		return res, err
	}
	if err := ag.Apply(ctx, spec.Rules, spec.Root); err != nil {
		return res, err
	}
	res.Residual, err = ag.Scan(ctx, spec.Rules, spec.Root)
	return res, err
}

// FollowUp is the body of an agent follow-up ticket listing the hits the rules could not rewrite, or
// empty when none remain.
func FollowUp(r TransformResult) string {
	if len(r.Residual) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("The rules rewrote what they could. These places still match and need a person or an agent:\n\n")
	for _, h := range r.Residual {
		fmt.Fprintf(&b, "- %s:%d (%s)\n", h.File, h.Line, h.Rule)
	}
	return b.String()
}

func compileRuleSchema() (*jsonschema.Resolved, error) {
	var s jsonschema.Schema
	if err := json.Unmarshal(ruleSchema, &s); err != nil {
		return nil, fmt.Errorf("transform: rule schema: %w", err)
	}
	return s.Resolve(nil)
}

// checkRule validates one rule file and returns its id. The schema lists the optional keys; id and
// language are the required ones in the rule config.
func checkRule(sch *jsonschema.Resolved, path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrRuleSchema, filepath.Base(path), err)
	}
	id, _ := doc["id"].(string)
	if lang, _ := doc["language"].(string); id == "" || lang == "" {
		return "", fmt.Errorf("%w: %s: id and language are required", ErrRuleSchema, filepath.Base(path))
	}
	if err := sch.Validate(doc); err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrRuleSchema, filepath.Base(path), err)
	}
	if !ruleID.MatchString(id) {
		return "", fmt.Errorf("%w: %s: id %q must be letters, digits, dot, dash or underscore", ErrRulePath, filepath.Base(path), id)
	}
	return id, nil
}

// ruleID names files in the rules dir, so it has no separator and does not start with a dot.
var ruleID = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]*$`)

// regularFile refuses a symlink or other non-regular file, which could point outside the rules dir.
func regularFile(path string) error {
	if fi, err := os.Lstat(path); err != nil || !fi.Mode().IsRegular() {
		return fmt.Errorf("%w: %s is not a regular file", ErrRulePath, filepath.Base(path))
	}
	return nil
}

func checkCases(path string) error {
	if _, err := os.Lstat(path); err == nil {
		if err := regularFile(path); err != nil {
			return err
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("%w: %s", ErrRuleCases, filepath.Base(path))
	}
	var c struct {
		Valid   []string `yaml:"valid"`
		Invalid []string `yaml:"invalid"`
	}
	if err := yaml.Unmarshal(data, &c); err != nil || len(c.Valid) == 0 || len(c.Invalid) == 0 {
		return fmt.Errorf("%w: %s", ErrRuleCases, filepath.Base(path))
	}
	return nil
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }
