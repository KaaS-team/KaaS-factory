package graph

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeAstGrep struct {
	testErr  error
	applyErr error
	hits     []Hit
	calls    []string
}

func (f *fakeAstGrep) Test(context.Context, string) error {
	f.calls = append(f.calls, "test")
	return f.testErr
}

func (f *fakeAstGrep) Apply(context.Context, string, string) error {
	f.calls = append(f.calls, "apply")
	return f.applyErr
}

func (f *fakeAstGrep) Scan(context.Context, string, string) ([]Hit, error) {
	f.calls = append(f.calls, "scan")
	return f.hits, nil
}

const goodRule = "id: no-var\nlanguage: typescript\nrule:\n  pattern: var $A = $B\nfix: let $A = $B\n"
const goodCases = "id: no-var\nvalid:\n  - let a = 1\ninvalid:\n  - var a = 1\n"

func rulesDir(t *testing.T, rule, cases string, snapshot bool) string {
	t.Helper()
	dir := t.TempDir()
	put := func(p, s string) {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, p), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if rule != "" {
		put("no-var.yml", rule)
	}
	if cases != "" {
		put("tests/no-var-test.yml", cases)
	}
	if snapshot {
		put("__snapshots__/no-var-snapshot.yml", "id: no-var\n")
	}
	return dir
}

// Symphony 5 workflow shape; the transform step authors, tests, then applies with no model call.
func TestRunTransform(t *testing.T) {
	boom := errors.New("boom")
	tests := []struct {
		name     string
		rule     string
		cases    string
		snapshot bool
		ag       *fakeAstGrep
		wantErr  error
		wantMsg  string
		calls    string
		residual int
		land     int
	}{
		{name: "applies and lists residue", rule: goodRule, cases: goodCases, snapshot: true,
			ag: &fakeAstGrep{hits: []Hit{{File: "a.ts", Line: 3, Rule: "no-var"}}}, calls: "test apply scan", residual: 1, land: 3},
		{name: "clean tree", rule: goodRule, cases: goodCases, ag: &fakeAstGrep{}, calls: "test apply scan", land: 2},
		{name: "no rule files", ag: &fakeAstGrep{}, wantErr: ErrNoRule},
		{name: "schema violation", rule: "id: x\nlanguage: typescript\nrule:\n  nonsense: 1\n", cases: goodCases, ag: &fakeAstGrep{},
			wantErr: ErrRuleSchema, wantMsg: "no-var.yml"},
		{name: "missing id", rule: "language: typescript\nrule:\n  pattern: a\n", cases: goodCases, ag: &fakeAstGrep{}, wantErr: ErrRuleSchema},
		{name: "no test cases file", rule: goodRule, ag: &fakeAstGrep{}, wantErr: ErrRuleCases},
		{name: "no invalid case", rule: goodRule, cases: "id: no-var\nvalid:\n  - let a = 1\n", ag: &fakeAstGrep{}, wantErr: ErrRuleCases},
		{name: "no valid case", rule: goodRule, cases: "id: no-var\ninvalid:\n  - var a = 1\n", ag: &fakeAstGrep{}, wantErr: ErrRuleCases},
		{name: "test fails, nothing applied", rule: goodRule, cases: goodCases, ag: &fakeAstGrep{testErr: boom}, wantErr: boom, calls: "test"},
		{name: "apply fails", rule: goodRule, cases: goodCases, ag: &fakeAstGrep{applyErr: boom}, wantErr: boom, calls: "test apply"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := rulesDir(t, tc.rule, tc.cases, tc.snapshot)
			res, err := RunTransform(context.Background(), tc.ag, TransformSpec{Rules: dir, Root: t.TempDir()})
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("want %v, got %v", tc.wantErr, err)
				}
				if tc.wantMsg != "" && !strings.Contains(err.Error(), tc.wantMsg) {
					t.Errorf("error %q lacks %q", err, tc.wantMsg)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(tc.ag.calls, " "); got != tc.calls {
				t.Errorf("calls %q, want %q", got, tc.calls)
			}
			if tc.wantErr == nil && (len(res.Residual) != tc.residual || len(res.Land) != tc.land) {
				t.Errorf("residual %d land %d, want %d and %d: %+v", len(res.Residual), len(res.Land), tc.residual, tc.land, res)
			}
		})
	}
}

func TestFollowUpListsResidue(t *testing.T) {
	if got := FollowUp(TransformResult{}); got != "" {
		t.Errorf("no residue must give no follow-up, got %q", got)
	}
	got := FollowUp(TransformResult{Residual: []Hit{{File: "a.ts", Line: 3, Rule: "no-var"}}})
	if !strings.Contains(got, "a.ts:3") || !strings.Contains(got, "no-var") {
		t.Errorf("follow-up %q", got)
	}
}

func TestTransformStep(t *testing.T) {
	ok := "steps:\n  t: { uses: transform, rules: .factory/rules }\n"
	g, err := ParseYAML("w", []byte(ok))
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := g.Node("t"); n.Kind != KindTransform || n.Rules != ".factory/rules" {
		t.Errorf("node %+v", n)
	}
	for name, src := range map[string]string{
		"needs rules":       "steps:\n  t: { uses: transform }\n",
		"rules elsewhere":   "steps:\n  b: { uses: build, rules: x }\n",
		"no agent settings": "steps:\n  t: { uses: transform, rules: x, tier: small }\n",
	} {
		if _, err := ParseYAML("w", []byte(src)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

// The id names the tests and snapshot files, so it must not climb out of the rules dir, and a rule,
// tests or snapshot file that is a symlink must not pull in a file from elsewhere.
func TestTransformRefusesPathEscape(t *testing.T) {
	for _, id := range []string{"../../etc/passwd", "a/b", `a\b`, "..", ".hidden"} {
		rule := "id: " + id + "\nlanguage: typescript\nrule:\n  pattern: var $A = $B\n"
		dir := rulesDir(t, rule, goodCases, false)
		ag := &fakeAstGrep{}
		if _, err := RunTransform(context.Background(), ag, TransformSpec{Rules: dir, Root: t.TempDir()}); !errors.Is(err, ErrRulePath) {
			t.Errorf("id %q: want ErrRulePath, got %v", id, err)
		}
		if len(ag.calls) != 0 {
			t.Errorf("id %q: ast-grep ran: %v", id, ag.calls)
		}
	}
	dir := rulesDir(t, goodRule, goodCases, false)
	outside := filepath.Join(t.TempDir(), "outside.yml")
	if err := os.WriteFile(outside, []byte(goodCases), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := filepath.Join(dir, "tests", "no-var-test.yml")
	if err := os.Remove(cases); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, cases); err != nil {
		t.Skip("no symlinks here")
	}
	if _, err := RunTransform(context.Background(), &fakeAstGrep{}, TransformSpec{Rules: dir, Root: t.TempDir()}); !errors.Is(err, ErrRulePath) {
		t.Errorf("symlinked tests file: want ErrRulePath, got %v", err)
	}
}

func TestTransformRulesDirStaysInTheRepo(t *testing.T) {
	for _, r := range []string{"/etc", "../rules", "a/../../b"} {
		if _, err := ParseYAML("w", []byte("steps:\n  t: { uses: transform, rules: "+r+" }\n")); err == nil {
			t.Errorf("rules %q: want an error", r)
		}
	}
}
