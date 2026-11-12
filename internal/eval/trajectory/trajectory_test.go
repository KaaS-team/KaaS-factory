package trajectory

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func rec(task, state string, steps int, in, out int64, diff string) Trajectory {
	t := Trajectory{Task: task, State: state, Submission: diff, Cost: Cost{InputTokens: in, OutputTokens: out, CostUSD: 0.5}}
	for i := 0; i < steps; i++ {
		t.Steps = append(t.Steps, Step{Action: "edit"})
	}
	if diff != "" && steps > 0 {
		t.Steps[steps-1].Diff = diff
	}
	return t
}

func TestWriteReadReplayReproducesDiff(t *testing.T) {
	dir := t.TempDir()
	want := "--- a/x.go\n+++ b/x.go\n@@\n-old\n+new\n"
	p, err := Write(dir, rec("fx/T-1", StatePass, 3, 10, 5, want))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(p) != "fx%2FT-1.json" {
		t.Fatalf("file name %s", p)
	}
	got, err := Read(p)
	if err != nil {
		t.Fatal(err)
	}
	diff, err := Replay(got)
	if err != nil || diff != want {
		t.Fatalf("replay = %q, %v; want the recorded diff", diff, err)
	}
}

func TestReplayRejectsBrokenFiles(t *testing.T) {
	good := rec("a", StatePass, 2, 1, 1, "diff1")
	good.Seal()
	cut := good
	cut.Submission = "" // the final diff is gone
	subEdited := good
	subEdited.Submission = "tampered" // steps and checksum still agree with each other
	edited := good
	edited.Submission, edited.Steps = "other", []Step{{Diff: "other"}}
	stepEdited := good
	stepEdited.Steps = []Step{{Diff: "diff1"}, {Diff: "tampered"}} // submission and checksum still agree with each other
	for name, tr := range map[string]Trajectory{"cut": cut, "submission edited": subEdited, "edited": edited, "step edited": stepEdited} {
		if _, err := Replay(tr); err == nil {
			t.Errorf("%s: replay succeeded", name)
		}
	}
}

func TestReadAndLoadErrors(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte(`{"schema":"x"}`), 0o644)
	if _, err := Read(bad); err == nil || !strings.Contains(err.Error(), "schema") {
		t.Fatalf("wrong schema: %v", err)
	}
	if _, err := Load(t.TempDir()); err == nil {
		t.Fatal("empty dir loaded")
	}
	if _, err := Write(dir, Trajectory{}); err == nil {
		t.Fatal("empty task written")
	}
	d3 := t.TempDir()
	tampered := rec("t", StatePass, 2, 1, 1, "diff1")
	p, _ := Write(d3, tampered)
	raw, _ := os.ReadFile(p)
	_ = os.WriteFile(p, bytes.Replace(raw, []byte(`"diff": "diff1"`), []byte(`"diff": "evil"`), 1), 0o644)
	if _, err := Load(d3); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tampered file loaded: %v", err)
	}
	d2 := t.TempDir()
	a := rec("same", StatePass, 1, 1, 1, "")
	_, _ = Write(d2, a)
	raw, _ = os.ReadFile(filepath.Join(d2, "same.json"))
	_ = os.WriteFile(filepath.Join(d2, "copy.json"), raw, 0o644)
	if _, err := Load(d2); err == nil || !strings.Contains(err.Error(), "both") {
		t.Fatalf("duplicate task: %v", err)
	}
}

func TestSummarize(t *testing.T) {
	cases := []struct {
		name         string
		in           []Trajectory
		pass         float64
		mean, median float64
	}{
		{"empty", nil, 0, 0, 0},
		{"odd", []Trajectory{rec("a", StatePass, 1, 1, 1, ""), rec("b", StateFail, 5, 1, 1, ""), rec("c", StatePass, 3, 1, 1, "")}, 2.0 / 3, 3, 3},
		{"even", []Trajectory{rec("a", StatePass, 2, 1, 1, ""), rec("b", StateAborted, 4, 1, 1, "")}, 0.5, 3, 3},
	}
	for _, c := range cases {
		s := Summarize(c.in)
		if s.PassRate != c.pass || s.MeanSteps != c.mean || s.MedianSteps != c.median {
			t.Errorf("%s: %+v", c.name, s)
		}
	}
	s := Summarize([]Trajectory{rec("a", StatePass, 1, 10, 4, ""), rec("b", StateFail, 1, 20, 6, "")})
	if s.InputTokens != 30 || s.OutputTokens != 10 || s.CostUSD != 1 || s.ByState[StateFail] != 1 {
		t.Errorf("totals: %+v", s)
	}
}

func TestCompare(t *testing.T) {
	old := []Trajectory{rec("a", StateFail, 4, 10, 0, ""), rec("b", StatePass, 2, 10, 0, ""), rec("c", StatePass, 2, 10, 0, ""), rec("gone", StatePass, 1, 1, 1, ""), rec("d", StateFail, 1, 1, 1, "")}
	next := []Trajectory{rec("a", StatePass, 2, 5, 0, ""), rec("b", StateFail, 2, 10, 0, ""), rec("c", StatePass, 2, 10, 0, ""), rec("new", StatePass, 1, 1, 1, ""), rec("d", StateAborted, 1, 1, 1, "")}
	c := Compare(old, next)
	if c.Fixed != 1 || c.Regress != 1 || len(c.Changes) != 3 {
		t.Fatalf("%+v", c)
	}
	if len(c.OnlyOld) != 1 || c.OnlyOld[0] != "gone" || len(c.OnlyNew) != 1 || c.OnlyNew[0] != "new" {
		t.Fatalf("only lists: %+v", c)
	}
	md := c.Markdown()
	for _, w := range []string{"a: fail -> pass", "b: pass -> fail", "gone: only in old", "new: only in new", "Fixed: 1. Regressed: 1."} {
		if !strings.Contains(md, w) {
			t.Errorf("missing %q in\n%s", w, md)
		}
	}
}

// TestCommandsOffline runs both subcommands over files on disk: no runner, no network, no model.
func TestCommandsOffline(t *testing.T) {
	oldDir, newDir := t.TempDir(), t.TempDir()
	_, _ = Write(oldDir, rec("t1", StateFail, 3, 10, 2, ""))
	_, _ = Write(newDir, rec("t1", StatePass, 2, 8, 2, ""))
	var out bytes.Buffer
	st := NewStatsCommand()
	st.SetOut(&out)
	st.SetArgs([]string{newDir})
	if err := st.Execute(); err != nil || !strings.Contains(out.String(), "Pass rate: 1.00") {
		t.Fatalf("stats: %v\n%s", err, out.String())
	}
	out.Reset()
	cp := NewCompareCommand()
	cp.SetOut(&out)
	cp.SetArgs([]string{oldDir, newDir})
	if err := cp.Execute(); err != nil || !strings.Contains(out.String(), "t1: fail -> pass") {
		t.Fatalf("compare: %v\n%s", err, out.String())
	}
	cp = NewCompareCommand()
	cp.SetArgs([]string{oldDir, filepath.Join(newDir, "missing")})
	cp.SetOut(&out)
	cp.SetErr(&out)
	if err := cp.Execute(); err == nil {
		t.Fatal("missing path accepted")
	}
}

// "a/b" and "a-b" are different tasks and must not share a file.
func TestFileNameIsInjective(t *testing.T) {
	dir := t.TempDir()
	for _, task := range []string{"a/b", "a-b", "a%2Fb"} {
		if _, err := Write(dir, rec(task, StatePass, 1, 1, 1, "d-"+task)); err != nil {
			t.Fatal(err)
		}
	}
	if FileName("a/b") == FileName("a-b") || FileName("a%2Fb") == FileName("a/b") {
		t.Fatalf("collision: %s %s %s", FileName("a/b"), FileName("a-b"), FileName("a%2Fb"))
	}
	got, err := Load(dir)
	if err != nil || len(got) != 3 {
		t.Fatalf("load = %d trajectories, %v; want 3", len(got), err)
	}
}

// A file with a submission and no step diff loads and replays to the submission.
func TestSubmissionOnlyFileLoads(t *testing.T) {
	dir := t.TempDir()
	tr := Trajectory{Task: "s", State: StatePass, Submission: "the diff", Steps: []Step{{Action: "edit"}}}
	if _, err := Write(dir, tr); err != nil {
		t.Fatal(err)
	}
	got, err := Load(dir)
	if err != nil || len(got) != 1 {
		t.Fatalf("load = %v, %v", got, err)
	}
	if diff, err := Replay(got[0]); err != nil || diff != "the diff" {
		t.Fatalf("replay = %q, %v", diff, err)
	}
}
