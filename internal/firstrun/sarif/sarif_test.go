package sarif

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
)

func sample() ([]Finding, []Suppressed) {
	return []Finding{
			{ID: "actions-pinned-sha", Title: "Pinned workflow actions", Severity: "warn", File: ".github/workflows/ci.yml", Line: 24, Detail: "not pinned"},
			{ID: "ci-pr-minutes", Title: "PR CI cap", Severity: "fail", Detail: "no cap"},
			{ID: "note-only", Title: "Note", Severity: "info"},
		}, []Suppressed{
			{Finding: Finding{ID: "env-example", Title: "Env example", Severity: "warn", File: ".env", Line: 1}, Reason: TestData},
		}
}

// loadSchema reads the vendored SARIF 2.1.0 schema (draft-04) and rewrites it to draft-07, the
// oldest draft the validator supports; the SARIF schema uses no draft-04-only keyword.
func loadSchema(t *testing.T) *jsonschema.Resolved {
	t.Helper()
	raw, err := os.ReadFile("testdata/sarif-schema-2.1.0.json")
	if err != nil {
		t.Fatal(err)
	}
	s := strings.Replace(string(raw), "draft-04/schema#", "draft-07/schema#", 1)
	s = strings.Replace(s, "\"id\": \"https://docs", "\"$id\": \"https://docs", 1)
	var sch jsonschema.Schema
	if err := json.Unmarshal([]byte(s), &sch); err != nil {
		t.Fatal(err)
	}
	rs, err := sch.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	return rs
}

func TestSARIFValidatesAgainstSchema(t *testing.T) {
	kept, sup := sample()
	out, err := Marshal("1.2.3", kept, sup)
	if err != nil {
		t.Fatal(err)
	}
	var doc any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	if err := loadSchema(t).Validate(doc); err != nil {
		t.Fatalf("SARIF does not validate: %v\n%s", err, out)
	}
	// The validator must be able to say no: a run without tool.driver is rejected.
	bad := map[string]any{"version": "2.1.0", "runs": []any{map[string]any{"tool": map[string]any{}}}}
	if err := loadSchema(t).Validate(bad); err == nil {
		t.Fatal("schema accepted a run with no tool driver; the validation proves nothing")
	}
}

func TestSARIFResults(t *testing.T) {
	kept, sup := sample()
	out, err := Marshal("1.2.3", kept, sup)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Runs []struct {
			Tool struct {
				Driver struct {
					Rules []struct{ ID string }
				}
			}
			Results []struct {
				RuleID       string
				Level        string
				Locations    []json.RawMessage
				Suppressions []struct{ Kind, Justification string }
			}
		}
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	r := doc.Runs[0]
	if len(r.Results) != 4 || len(r.Tool.Driver.Rules) != 4 {
		t.Fatalf("results %d rules %d, want 4 each", len(r.Results), len(r.Tool.Driver.Rules))
	}
	want := map[string]string{"actions-pinned-sha": "warning", "ci-pr-minutes": "error", "note-only": "note", "env-example": "warning"}
	for _, res := range r.Results {
		if res.Level != want[res.RuleID] {
			t.Errorf("%s level %q, want %q", res.RuleID, res.Level, want[res.RuleID])
		}
		isSup := res.RuleID == "env-example"
		if isSup != (len(res.Suppressions) == 1) {
			t.Errorf("%s suppressions = %v", res.RuleID, res.Suppressions)
		}
		if isSup && !strings.Contains(res.Suppressions[0].Justification, "test-data") {
			t.Errorf("suppression carries no reason: %+v", res.Suppressions[0])
		}
		if res.RuleID == "ci-pr-minutes" && len(res.Locations) != 0 {
			t.Error("a finding with no file must have no location")
		}
	}
}
