package local

import "testing"

func r(a, res, e string) Rule { return Rule{a, res, e} }

// Cases ported from opencode core/test/permission.test.ts (evaluate and the
// configured-rule semantics) at a1aa513.
func TestEvaluate(t *testing.T) {
	for _, c := range []struct {
		name           string
		action, res    string
		sets           [][]Rule
		want           string
		wantFallbackOn bool
	}{
		{"no rules asks", "read", "x", nil, "ask", true},
		{"allow", "read", "x", [][]Rule{{r("read", "*", "allow")}}, "allow", false},
		{"later deny wins", "read", "x", [][]Rule{{r("read", "*", "allow")}, {r("read", "*", "deny")}}, "deny", false},
		{"later ask beats earlier allow", "bash", "pwd", [][]Rule{{r("*", "*", "allow"), r("bash", "*", "ask")}}, "ask", false},
		{"wildcard action", "bash", "pwd", [][]Rule{{r("*", "*", "allow")}}, "allow", false},
		{"other action no match", "edit", "a", [][]Rule{{r("read", "*", "allow")}}, "ask", true},
		{"path glob deny", "edit", "/original/src/index.ts", [][]Rule{{r("*", "*", "allow"), r("edit", "/original/**", "deny")}}, "deny", false},
		{"windows separators", "external_directory", "C:/Users/x/proj/src/*", [][]Rule{{r("external_directory", `C:\Users\x\proj\*`, "allow")}}, "allow", false},
		{"windows other dir", "external_directory", "C:/Users/x/other/*", [][]Rule{{r("external_directory", `C:\Users\x\proj\*`, "allow")}}, "ask", true},
		{"trailing space star matches bare command", "bash", "git status", [][]Rule{{r("bash", "git status *", "allow")}}, "allow", false},
		{"trailing space star matches args", "bash", "git status -s", [][]Rule{{r("bash", "git status *", "allow")}}, "allow", false},
		{"regex characters are literal", "bash", "git statusX", [][]Rule{{r("bash", "git status.", "allow")}}, "ask", true},
		{"question mark is one char", "bash", "ab", [][]Rule{{r("bash", "a?", "allow")}}, "allow", false},
	} {
		got := Evaluate(c.action, c.res, c.sets...)
		if got.Effect != c.want {
			t.Errorf("%s: got %q want %q", c.name, got.Effect, c.want)
		}
		if c.wantFallbackOn && got.Resource != "*" {
			t.Errorf("%s: fallback rule should carry resource *", c.name)
		}
	}
}

// Symphony spec 15 (safety): an unattended run never waits for approval.
func TestSettle(t *testing.T) {
	allow := []Rule{r("edit", "*", "allow")}
	for _, c := range []struct {
		name       string
		resources  []string
		cfg, unatt []Rule
		want       string
	}{
		{"configured allow", []string{"a"}, allow, nil, "allow"},
		{"ask stays ask when attended", []string{"a"}, nil, nil, "ask"},
		{"no allow rule denies a write", []string{"a"}, nil, []Rule{}, "deny"},
		{"unattended allow settles ask", []string{"a"}, nil, allow, "allow"},
		{"configured deny beats unattended allow", []string{"a"}, []Rule{r("edit", "*", "deny")}, allow, "deny"},
		{"deny on one resource denies all", []string{"a", "b"}, []Rule{r("edit", "b", "deny"), r("edit", "a", "allow")}, allow, "deny"},
		{"one unsettled resource denies", []string{"a", "b"}, nil, []Rule{r("edit", "a", "allow")}, "deny"},
		{"all settled resources allow", []string{"a", "b"}, nil, allow, "allow"},
		{"mixed configured and unattended", []string{"a", "b"}, []Rule{r("edit", "a", "allow")}, []Rule{r("edit", "b", "allow")}, "allow"},
	} {
		if got := Settle("edit", c.resources, c.cfg, c.unatt); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestStageRulesDenyWriteWithoutAllow(t *testing.T) {
	if got := Settle("edit", []string{"src/a.go"}, stageRules("plan", "7", Commands{}), []Rule{}); got != "deny" {
		t.Fatalf("plan stage may only edit its run dir, got %q", got)
	}
	if got := Settle("edit", []string{".factory/runs/issue-7/plan.json"}, stageRules("plan", "7", Commands{}), []Rule{}); got != "allow" {
		t.Fatalf("run dir edit: got %q", got)
	}
	if got := Settle("edit", []string{"src/a.go"}, stageRules("build", "7", Commands{}), []Rule{}); got != "allow" {
		t.Fatalf("build may edit: got %q", got)
	}
}
