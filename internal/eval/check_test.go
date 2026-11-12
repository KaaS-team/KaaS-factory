package eval

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// put writes a file under root, creating directories.
func put(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const goodFixture = `{"name":"fx","seed":"seed","hidden":"go test ./...","tickets":[{"id":"1","repo":"fx","title":"t","body":"b","priority":0,"created_at":"2026-01-01T00:00:00Z"}]}`

func good(t *testing.T) string {
	root := t.TempDir()
	put(t, root, "fx/fixture.yaml", goodFixture)
	put(t, root, "fx/seed/a.go", "package a")
	put(t, root, "fx/hidden/1/a_test.go", "package a")
	return root
}

func messages(ps []Problem) string {
	var b strings.Builder
	for _, p := range ps {
		b.WriteString(p.String() + "\n")
	}
	return b.String()
}

func TestCheckFixturesGood(t *testing.T) {
	if ps, err := CheckFixtures(good(t), false); err != nil || len(ps) != 0 {
		t.Fatalf("%v %v", err, messages(ps))
	}
}

func TestCheckFixturesProblems(t *testing.T) {
	cases := []struct {
		name  string
		edit  func(t *testing.T, root string)
		want  string
		fixes bool
	}{
		{"no fixture.yaml", func(t *testing.T, r string) { _ = os.Remove(filepath.Join(r, "fx/fixture.yaml")) }, "no fixture.yaml", false},
		{"not JSON", func(t *testing.T, r string) { put(t, r, "fx/fixture.yaml", "{") }, "not valid JSON", false},
		{"missing hidden key", func(t *testing.T, r string) {
			put(t, r, "fx/fixture.yaml", strings.Replace(goodFixture, `"hidden":"go test ./...",`, "", 1))
		}, "has no hidden", false},
		{"missing tickets key", func(t *testing.T, r string) { put(t, r, "fx/fixture.yaml", `{"name":"fx","seed":"seed","hidden":"x"}`) }, "has no tickets", false},
		{"empty tickets", func(t *testing.T, r string) {
			put(t, r, "fx/fixture.yaml", `{"name":"fx","seed":"seed","hidden":"x","tickets":[]}`)
		}, "no tickets", false},
		{"name differs from directory", func(t *testing.T, r string) {
			put(t, r, "fx/fixture.yaml", strings.Replace(goodFixture, `"name":"fx"`, `"name":"other"`, 1))
		}, `name is "other"`, true},
		{"missing name", func(t *testing.T, r string) {
			put(t, r, "fx/fixture.yaml", strings.Replace(goodFixture, `"name":"fx",`, "", 1))
		}, "has no name", true},
		{"missing seed key", func(t *testing.T, r string) {
			put(t, r, "fx/fixture.yaml", strings.Replace(goodFixture, `"seed":"seed",`, "", 1))
		}, "has no seed", true},
		{"seed directory missing", func(t *testing.T, r string) { _ = os.RemoveAll(filepath.Join(r, "fx/seed")) }, "seed directory", false},
		{"hidden directory for a ticket missing", func(t *testing.T, r string) { _ = os.RemoveAll(filepath.Join(r, "fx/hidden")) }, "hidden/1", false},
		{"ticket repo is not the fixture", func(t *testing.T, r string) {
			put(t, r, "fx/fixture.yaml", strings.Replace(goodFixture, `"repo":"fx"`, `"repo":"zz"`, 1))
		}, `repo is "zz"`, false},
		{"stray directory", func(t *testing.T, r string) { put(t, r, "stray/x", "") }, "no fixture.yaml", false},
		{"graded ticket without fail_to_pass", func(t *testing.T, r string) {
			put(t, r, "fx/fixture.yaml", strings.Replace(goodFixture, `"priority":0`, `"priority":0,"grade":{"fail_to_pass":[]}`, 1))
		}, "nothing grades", false},
		{"graded ticket with unknown parser", func(t *testing.T, r string) {
			put(t, r, "fx/fixture.yaml", strings.Replace(goodFixture, `"priority":0`, `"priority":0,"grade":{"fail_to_pass":["a"],"parser":"nope"}`, 1))
		}, `parser "nope"`, false},
		{"graded ticket with unknown eval_type", func(t *testing.T, r string) {
			put(t, r, "fx/fixture.yaml", strings.Replace(goodFixture, `"priority":0`, `"priority":0,"grade":{"fail_to_pass":["a"],"eval_type":"x"}`, 1))
		}, `eval_type "x"`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			root := good(t)
			c.edit(t, root)
			ps, err := CheckFixtures(root, false)
			if err != nil || !strings.Contains(messages(ps), c.want) {
				t.Fatalf("want %q, got err=%v\n%s", c.want, err, messages(ps))
			}
			var fixable bool
			for _, p := range ps {
				fixable = fixable || (p.Fixable && strings.Contains(p.String(), c.want))
			}
			if fixable != c.fixes {
				t.Fatalf("fixable=%v want %v", fixable, c.fixes)
			}
		})
	}
}

func TestCheckFixturesEmptyDir(t *testing.T) {
	ps, err := CheckFixtures(t.TempDir(), false)
	if err != nil || !strings.Contains(messages(ps), "no fixtures") {
		t.Fatalf("%v %s", err, messages(ps))
	}
}

func TestCheckFixturesFixWritesOnlyDerivableData(t *testing.T) {
	root := good(t)
	// name and seed are derivable from the tree; the hidden command is not, so a missing one stays a problem.
	put(t, root, "fx/fixture.yaml", `{"name":"other","tickets":[{"id":"1","repo":"fx","title":"t","body":"b"}]}`)
	ps, err := CheckFixtures(root, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := messages(ps); !strings.Contains(got, "has no hidden") || strings.Contains(got, "name") || strings.Contains(got, "seed") {
		t.Fatalf("remaining problems:\n%s", got)
	}
	raw, _ := os.ReadFile(filepath.Join(root, "fx/fixture.yaml"))
	if !strings.Contains(string(raw), `"name": "fx"`) || !strings.Contains(string(raw), `"seed": "seed"`) || strings.Contains(string(raw), `"hidden"`) {
		t.Fatalf("%s", raw)
	}
	// a fixture with nothing fixable is left byte for byte as it was
	root = good(t)
	before, _ := os.ReadFile(filepath.Join(root, "fx/fixture.yaml"))
	if _, err := CheckFixtures(root, true); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(filepath.Join(root, "fx/fixture.yaml")); !bytes.Equal(before, after) {
		t.Fatalf("rewritten:\n%s", after)
	}
}

func TestShippedFixturesAreWellFormed(t *testing.T) {
	ps, err := CheckFixtures(fixturesDir, false)
	if err != nil || len(ps) != 0 {
		t.Fatalf("%v\n%s", err, messages(ps))
	}
}

func TestCheckCommandFailsOnAProblem(t *testing.T) {
	root := good(t)
	run := func() (string, error) {
		cmd := NewCommand()
		var out bytes.Buffer
		cmd.SetOut(&out)
		cmd.SetArgs([]string{"check", "--fixtures", root})
		err := cmd.Execute()
		return out.String(), err
	}
	if out, err := run(); err != nil || !strings.Contains(out, "ok") {
		t.Fatalf("%v %s", err, out)
	}
	_ = os.RemoveAll(filepath.Join(root, "fx/hidden"))
	out, err := run()
	if !errors.Is(err, ErrFixtureProblems) || !strings.Contains(out, "hidden/1") {
		t.Fatalf("%v %s", err, out)
	}
}
