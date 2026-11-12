// Ported from SWE-bench/SWE-bench@02e7a74 swebench/task/checks.py

package eval

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/KaaS-team/factory/internal/eval/grade"
)

// ErrFixtureProblems is returned by `eval check` when a fixture is malformed.
var ErrFixtureProblems = errors.New("fixtures have problems")

// Problem is one thing wrong with a fixture. Fixable means `--fix` can derive the right value from the tree.
type Problem struct {
	Where, Message string
	Fixable        bool
}

func (p Problem) String() string { return p.Where + ": " + p.Message }

// requiredKeys must be present in every fixture.yaml; a fixture without them cannot be run.
var requiredKeys = []string{"name", "seed", "hidden", "tickets"}

// CheckFixtures reports every problem under dir, in directory order. With fix it first writes back what the
// tree itself determines (the name from the directory, the seed key when a seed directory exists) and reports what is left.
func CheckFixtures(dir string, fix bool) ([]Problem, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var ps []Problem
	var n int
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		n++
		fp := filepath.Join(dir, e.Name())
		found := checkFixture(fp, e.Name())
		if fix && anyFixable(found) {
			if err := fixFixture(fp, e.Name()); err != nil {
				return nil, err
			}
			found = checkFixture(fp, e.Name())
		}
		ps = append(ps, found...)
	}
	if n == 0 {
		ps = append(ps, Problem{Where: dir, Message: "no fixtures"})
	}
	return ps, nil
}

func anyFixable(ps []Problem) bool {
	for _, p := range ps {
		if p.Fixable {
			return true
		}
	}
	return false
}

func readRaw(fp string) (map[string]json.RawMessage, error) {
	b, err := os.ReadFile(filepath.Join(fp, "fixture.yaml"))
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	return raw, json.Unmarshal(b, &raw)
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func checkFixture(fp, name string) []Problem {
	p := func(msg string, fixable bool) Problem { return Problem{Where: name, Message: msg, Fixable: fixable} }
	if _, err := os.Stat(filepath.Join(fp, "fixture.yaml")); err != nil {
		return []Problem{p("no fixture.yaml, so it is not a fixture", false)}
	}
	raw, err := readRaw(fp)
	if err != nil {
		return []Problem{p("fixture.yaml is not valid JSON: "+err.Error(), false)}
	}
	var out []Problem
	for _, k := range requiredKeys {
		if _, ok := raw[k]; ok {
			continue
		}
		derivable := k == "name" || (k == "seed" && isDir(filepath.Join(fp, "seed")))
		out = append(out, p("fixture.yaml has no "+k, derivable))
	}
	var f Fixture
	if err := json.Unmarshal(mustJSON(raw), &f); err != nil {
		return append(out, p("fixture.yaml has a field of the wrong type: "+err.Error(), false))
	}
	if _, ok := raw["name"]; ok && f.Name != name {
		out = append(out, p(fmt.Sprintf("name is %q, not the directory name", f.Name), true))
	}
	if f.Seed != "" && !isDir(filepath.Join(fp, f.Seed)) {
		out = append(out, p(fmt.Sprintf("seed directory %q does not exist", f.Seed), false))
	}
	if _, ok := raw["tickets"]; ok && len(f.Tickets) == 0 {
		out = append(out, p("no tickets", false))
	}
	for _, t := range f.Tickets {
		if t.Repo != name {
			out = append(out, p(fmt.Sprintf("ticket %s repo is %q, not the fixture name", t.ID, t.Repo), false))
		}
		if !isDir(filepath.Join(fp, "hidden", string(t.ID))) {
			out = append(out, p(fmt.Sprintf("hidden/%s does not exist, so ticket %s has no acceptance test", t.ID, t.ID), false))
		}
		if g := t.Grade; g != nil {
			out = append(out, checkSpec(p, string(t.ID), *g)...)
		}
	}
	return out
}

func checkSpec(p func(string, bool) Problem, id string, g grade.Spec) []Problem {
	var out []Problem
	if len(g.FailToPass) == 0 {
		out = append(out, p(fmt.Sprintf("ticket %s grade has no fail_to_pass, so nothing grades it", id), false))
	}
	if g.Parser != "" && g.Parser != grade.ParserPytest && g.Parser != grade.ParserGoTest {
		out = append(out, p(fmt.Sprintf("ticket %s grade parser %q is not pytest or gotest", id, g.Parser), false))
	}
	if g.EvalType != "" && g.EvalType != grade.PassAndFail && g.EvalType != grade.FailOnly {
		out = append(out, p(fmt.Sprintf("ticket %s grade eval_type %q is not pass_and_fail or fail_only", id, g.EvalType), false))
	}
	return out
}

// mustJSON encodes a string or a map of raw values; neither can fail.
func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// fixFixture writes the derivable keys back. Keys come out sorted.
func fixFixture(fp, name string) error {
	raw, err := readRaw(fp)
	if err != nil {
		return err
	}
	raw["name"] = mustJSON(name)
	if _, ok := raw["seed"]; !ok && isDir(filepath.Join(fp, "seed")) {
		raw["seed"] = mustJSON("seed")
	}
	b, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(fp, "fixture.yaml"), append(b, '\n'), 0o644)
}
