package scanedit

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

var renameDecl = regexp.MustCompile(`(?m)^// rename (\w+) (\w+)$`)

func scanRename(_ context.Context, _ string, src []byte) (Acc, error) {
	acc := Acc{}
	for _, m := range renameDecl.FindAllSubmatch(src, -1) {
		acc[string(m[1])] = string(m[2])
	}
	return acc, nil
}

func editRename(_ context.Context, _ string, src []byte, acc Acc) ([]byte, int64, error) {
	out := src
	for old, nw := range acc {
		out = regexp.MustCompile(`\b`+old+`\b`).ReplaceAll(out, []byte(nw))
	}
	return out, 0, nil
}

func fixture(t *testing.T, files map[string]string) (string, []string) {
	t.Helper()
	root := t.TempDir()
	var names []string
	for n, c := range files {
		if err := os.WriteFile(filepath.Join(root, n), []byte(c), 0o600); err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	return root, names
}

func read(t *testing.T, root, n string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, n))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// AC1: a rename declared in one file is applied in every file, found by the read-only scan pass.
func TestCrossFileRename(t *testing.T) {
	root, files := fixture(t, map[string]string{
		"decl.txt": "// rename OldName NewName\nfunc OldName() {}\n",
		"use.txt":  "OldName()\nOldNameOther()\n",
	})
	cfg := Config{Root: root, Files: files, AccPath: filepath.Join(t.TempDir(), "acc.json"), Deadline: time.Second}
	scanRows, err := Scan(context.Background(), cfg, scanRename)
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, root, "use.txt"); !strings.Contains(got, "OldName()") {
		t.Fatalf("scan wrote a file: %q", got)
	}
	editRows, err := Edit(context.Background(), cfg, editRename)
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, root, "use.txt"); got != "NewName()\nOldNameOther()\n" {
		t.Fatalf("use.txt = %q", got)
	}
	if got := read(t, root, "decl.txt"); !strings.Contains(got, "func NewName()") {
		t.Fatalf("decl.txt = %q", got)
	}
	for _, r := range append(scanRows, editRows...) {
		if r.Result != ResultOK {
			t.Fatalf("row %+v", r)
		}
	}
}

// AC2: a hung file is abandoned and reported, the run continues, and the hung file is untouched.
func TestHungFileAbandoned(t *testing.T) {
	root, files := fixture(t, map[string]string{"a.txt": "x", "hang.txt": "x", "z.txt": "x"})
	cfg := Config{Root: root, Files: files, AccPath: filepath.Join(t.TempDir(), "acc.json"), Deadline: 50 * time.Millisecond}
	block := make(chan struct{})
	defer close(block)
	edit := func(_ context.Context, f string, src []byte, _ Acc) ([]byte, int64, error) {
		if f == "hang.txt" {
			<-block // ignores ctx, like a stuck tool
		}
		return []byte("done"), 7, nil
	}
	if _, err := Scan(context.Background(), cfg, func(context.Context, string, []byte) (Acc, error) { return Acc{}, nil }); err != nil {
		t.Fatal(err)
	}
	rows, err := Edit(context.Background(), cfg, edit)
	if err != nil {
		t.Fatal(err)
	}
	res := map[string]string{}
	for _, r := range rows {
		res[r.File] = r.Result
	}
	if res["hang.txt"] != ResultTimeout || res["a.txt"] != ResultOK || res["z.txt"] != ResultOK {
		t.Fatalf("results %v", res)
	}
	if read(t, root, "hang.txt") != "x" || read(t, root, "z.txt") != "done" {
		t.Fatal("hung file changed or later file skipped")
	}
}

func TestErrorsAndConflicts(t *testing.T) {
	root, files := fixture(t, map[string]string{"a.txt": "a", "b.txt": "b"})
	cfg := Config{Root: root, Files: files, AccPath: filepath.Join(t.TempDir(), "acc.json"), Deadline: time.Second}
	// Both files claim key k with different values: the later file is a conflict row.
	rows, err := Scan(context.Background(), cfg, func(_ context.Context, f string, _ []byte) (Acc, error) {
		return Acc{"k": f}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var bad int
	for _, r := range rows {
		if r.Result != ResultOK {
			bad++
			if !strings.HasPrefix(r.Result, ResultError) {
				t.Fatalf("row %+v", r)
			}
		}
	}
	if bad != 1 {
		t.Fatalf("want one conflict, got %+v", rows)
	}
	// An edit error is reported and leaves the file alone.
	rows, err = Edit(context.Background(), cfg, func(context.Context, string, []byte, Acc) ([]byte, int64, error) {
		return nil, 0, os.ErrInvalid
	})
	if err != nil || len(rows) != 2 || !strings.HasPrefix(rows[0].Result, ResultError) {
		t.Fatalf("rows %+v err %v", rows, err)
	}
	if read(t, root, "a.txt") != "a" {
		t.Fatal("file changed on error")
	}
}

func TestEditNeedsAccumulator(t *testing.T) {
	root, files := fixture(t, map[string]string{"a.txt": "a"})
	cfg := Config{Root: root, Files: files, AccPath: filepath.Join(t.TempDir(), "missing.json"), Deadline: time.Second}
	if _, err := Edit(context.Background(), cfg, editRename); err == nil {
		t.Fatal("edit ran without a scan")
	}
}

func TestCanceledRunStops(t *testing.T) {
	root, files := fixture(t, map[string]string{"a.txt": "a"})
	cfg := Config{Root: root, Files: files, AccPath: filepath.Join(t.TempDir(), "acc.json"), Deadline: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Scan(ctx, cfg, scanRename); err == nil {
		t.Fatal("canceled scan returned no error")
	}
}

// AC3: the CSV has file, step, result, tokens and folds into a scorecard row.
func TestCSVFeedsScorecard(t *testing.T) {
	rows := []Row{
		{File: "a.txt", Step: StepEdit, Result: ResultOK, Tokens: 10},
		{File: "b,c.txt", Step: StepEdit, Result: ResultTimeout, Tokens: 0},
	}
	var buf bytes.Buffer
	if err := WriteCSV(&buf, rows); err != nil {
		t.Fatal(err)
	}
	want := "file,step,result,tokens\na.txt,edit,ok,10\n\"b,c.txt\",edit,timeout,0\n"
	if buf.String() != want {
		t.Fatalf("csv:\n%s", buf.String())
	}
	back, err := ReadCSV(&buf)
	if err != nil || len(back) != 2 || back[1] != rows[1] {
		t.Fatalf("roundtrip %+v %v", back, err)
	}
	tr := Scorecard("rename", rows)
	if tr.Fixture != "rename" || tr.InputTokens != 10 || tr.HiddenPass || tr.Merged {
		t.Fatalf("with a timeout the row must fail: %+v", tr)
	}
	if ok := Scorecard("rename", rows[:1]); !ok.HiddenPass {
		t.Fatalf("clean rows must pass: %+v", ok)
	}
	if _, err := ReadCSV(strings.NewReader("a,b\n")); err == nil {
		t.Fatal("bad header accepted")
	}
}
