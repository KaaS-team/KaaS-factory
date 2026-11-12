package migration

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type fakeExec struct {
	calls  []string
	failOn string
}

func (f *fakeExec) Exec(_ context.Context, _ string, argv []string) error {
	f.calls = append(f.calls, "exec "+strings.Join(argv, " "))
	if f.failOn != "" && argv[0] == f.failOn {
		return errors.New("boom")
	}
	return nil
}

func (f *fakeExec) Prompt(_ context.Context, _, prompt string, files []string) error {
	f.calls = append(f.calls, "prompt "+prompt+" "+strings.Join(files, ","))
	return nil
}

type fakeMeter map[string]int

func (m fakeMeter) Skipped(step string, n int) { m[step] = n }

func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for p, c := range files {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func samplePack(t *testing.T) *Pack {
	t.Helper()
	b, err := os.ReadFile("testdata/react-bump.yaml")
	if err != nil {
		t.Fatal(err)
	}
	p, err := Load(b)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSamplePackRunsEndToEnd(t *testing.T) {
	root := writeTree(t, map[string]string{
		"package.json":     `{"dependencies":{"react":"17.0.2"}}`,
		"src/app.tsx":      "ReactDOM.render(a, b)",
		"src/app.test.tsx": "it('x')",
		"src/other.tsx":    "export {}",
		".git/config":      "ReactDOM.render(",
	})
	ex, m, log := &fakeExec{}, fakeMeter{}, &bytes.Buffer{}
	res, err := Run(context.Background(), samplePack(t), Options{Root: root, Exec: ex, Meter: m, Log: log})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"exec npm install react@18",
		"prompt Replace ReactDOM.render with createRoot in the listed files. src/app.tsx",
		"exec npx jest src/app.test.tsx",
	}
	if strings.Join(ex.calls, "|") != strings.Join(want, "|") {
		t.Fatalf("calls:\n%v\nwant:\n%v", ex.calls, want)
	}
	if len(res) != 3 || !res[0].Ran || res[1].Matched != 1 || res[1].Skipped != 3 {
		t.Fatalf("results: %+v", res)
	}
}

func TestStepWithNoMatchingFilesSpendsNothing(t *testing.T) {
	root := writeTree(t, map[string]string{"package.json": `{"dependencies":{"react":"17.0.2"}}`, "src/a.tsx": "export {}"})
	ex, m, log := &fakeExec{}, fakeMeter{}, &bytes.Buffer{}
	res, err := Run(context.Background(), samplePack(t), Options{Root: root, Exec: ex, Meter: m, Log: log})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range ex.calls {
		if strings.HasPrefix(c, "prompt") {
			t.Fatalf("prompt step ran with no matching files: %v", ex.calls)
		}
	}
	if res[1].Ran || res[1].Matched != 0 {
		t.Fatalf("step 2: %+v", res[1])
	}
	if !strings.Contains(log.String(), "step update-render-calls: skipped: precondition") {
		t.Fatalf("log: %q", log.String())
	}
	if m["update-render-calls"] != 2 {
		t.Fatalf("meter: %v", m)
	}
}

func TestPackPreconditionGatesEveryStep(t *testing.T) {
	root := writeTree(t, map[string]string{"package.json": `{"dependencies":{"react":"18.2.0"}}`, "src/a.tsx": "ReactDOM.render("})
	ex := &fakeExec{}
	res, err := Run(context.Background(), samplePack(t), Options{Root: root, Exec: ex})
	if err != nil || len(ex.calls) != 0 {
		t.Fatalf("calls %v err %v", ex.calls, err)
	}
	for _, r := range res {
		if r.Ran {
			t.Fatalf("ran: %+v", r)
		}
	}
}

func TestFailingStepStopsTheRun(t *testing.T) {
	root := writeTree(t, map[string]string{"package.json": `{"dependencies":{"react":"17.0.2"}}`, "src/a.tsx": "ReactDOM.render("})
	ex := &fakeExec{failOn: "npm"}
	res, err := Run(context.Background(), samplePack(t), Options{Root: root, Exec: ex})
	if err == nil || !strings.Contains(err.Error(), "bump-dependency") || len(res) != 0 || len(ex.calls) != 1 {
		t.Fatalf("err %v res %v calls %v", err, res, ex.calls)
	}
}

func TestCanceledContextStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	root := writeTree(t, map[string]string{"a": "x"})
	if _, err := Run(ctx, samplePack(t), Options{Root: root, Exec: &fakeExec{}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v", err)
	}
}

func TestVerify(t *testing.T) {
	data := []byte("pack")
	if err := Verify("0000", data); err == nil {
		t.Fatal("want mismatch")
	}
	if err := Verify(sha256Sum(data), data); err != nil {
		t.Fatal(err)
	}
}

func TestExecRunnerPromptHandsOff(t *testing.T) {
	var out bytes.Buffer
	if err := (ExecRunner{Out: &out}).Prompt(context.Background(), "", "do it", []string{"a", "b"}); !errors.Is(err, ErrNoAgent) || out.String() != "prompt: do it\nfiles: a b\n" {
		t.Fatalf("%q %v", out.String(), err)
	}
	if err := (ExecRunner{Out: &out}).Exec(context.Background(), t.TempDir(), []string{"true"}); err != nil {
		t.Fatal(err)
	}
	if err := (ExecRunner{Out: &out}).Exec(context.Background(), t.TempDir(), []string{"false"}); err == nil {
		t.Fatal("want exit error")
	}
}

// A matched file named like a flag reaches the command as a path, not as an option.
func TestFilesStartingWithDashAreNotFlags(t *testing.T) {
	got := expand([]string{"rm", "{files}"}, []string{"-rf", "--force", "-x/y.go", "normal.go", "d/-n"})
	want := []string{"rm", "./-rf", "./--force", "./-x/y.go", "normal.go", "d/-n"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// End to end: a real command sees a file called -rf as an operand and leaves it be.
func TestDashFileSurvivesRealCommand(t *testing.T) {
	root := t.TempDir()
	for _, n := range []string{"-rf", "ok.txt"} {
		if err := os.WriteFile(filepath.Join(root, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	argv := expand([]string{"ls", "{files}"}, []string{"-rf", "ok.txt"})
	var out bytes.Buffer
	if err := (ExecRunner{Out: &out}).Exec(context.Background(), root, argv); err != nil {
		t.Fatalf("ls %v: %v: %s", argv, err, out.String())
	}
	if !strings.Contains(out.String(), "-rf") || !strings.Contains(out.String(), "ok.txt") {
		t.Fatalf("output %q", out.String())
	}
}

// With the default runner a prompt step fails the run and is not reported as ran.
func TestDefaultRunnerPromptStepIsNotReportedAsRan(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	p := &Pack{Name: "p", Steps: []Step{{Name: "ask", Prompt: "do it"}}}
	var log bytes.Buffer
	res, err := Run(context.Background(), p, Options{Root: root, Exec: ExecRunner{Out: &log}, Log: &log})
	if !errors.Is(err, ErrNoAgent) {
		t.Fatalf("want ErrNoAgent, got %v", err)
	}
	for _, r := range res {
		if r.Ran {
			t.Fatalf("prompt step reported ran: %+v", res)
		}
	}
	if strings.Contains(log.String(), "ran on") {
		t.Fatalf("log claims it ran: %s", log.String())
	}
}
