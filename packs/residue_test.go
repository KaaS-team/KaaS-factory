package packs_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/gate"
	"github.com/KaaS-team/factory/internal/graph"
)

const residueScript = "checks/ast-grep-residue/check.sh"

// fakeBin writes an executable shell script named name into a fresh dir and returns the dir.
func fakeBin(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// runResidue runs the check in a repo whose config names a rules dir, with PATH limited to bin plus the basics.
func runResidue(t *testing.T, bin string) (gate.Result, string) {
	t.Helper()
	repo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, ".factory"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repo, "rules", "residue"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "rules", "residue", "old-api.yml"), []byte("id: old-api\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := `{"residue":{"rules":"rules/residue"}}`
	if err := os.WriteFile(filepath.Join(repo, ".factory", "config.json"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs(residueScript)
	if err != nil {
		t.Fatal(err)
	}
	jq, err := exec.LookPath("jq")
	if err != nil {
		t.Skip("jq not installed")
	}
	jqDir := t.TempDir()
	if err := os.Symlink(jq, filepath.Join(jqDir, "jq")); err != nil {
		t.Fatal(err)
	}
	path := bin + ":" + jqDir + ":/usr/bin:/bin"
	cmd := exec.Command("/bin/sh", script)
	cmd.Dir = repo
	cmd.Env = []string{"PATH=" + path, "HOME=" + repo}
	out, _ := cmd.CombinedOutput()
	r, ok := gate.Parse(string(out))
	if !ok {
		t.Fatalf("no FACTORY_GATES line in %q", out)
	}
	return r, string(out)
}

func TestResidueCheck(t *testing.T) {
	two := "printf '%s\\n' '{\"ruleId\":\"old-api\",\"file\":\"a.go\"}' '{\"ruleId\":\"old-api\",\"file\":\"b.go\"}'\n"
	tests := []struct {
		name    string
		bin     string
		green   bool
		want    string
		wantAlt string
	}{
		{"two matches fail", fakeBin(t, "ast-grep", two), false, "residue=2", ""},
		{"no matches pass", fakeBin(t, "ast-grep", "exit 0\n"), true, "residue=0", ""},
		{"scan error fails", fakeBin(t, "ast-grep", "echo boom >&2; exit 2\n"), false, "ast-grep scan failed", ""},
		{"missing binary fails with install hint", t.TempDir(), false, "npm install --global @ast-grep/cli", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r, out := runResidue(t, tc.bin)
			if r.Green() != tc.green {
				t.Errorf("green=%v want %v: %s", r.Green(), tc.green, out)
			}
			if !strings.Contains(out, tc.want) {
				t.Errorf("output lacks %q: %s", tc.want, out)
			}
		})
	}
}

func TestResidueRequiresRulesDir(t *testing.T) {
	repo := t.TempDir()
	script, _ := filepath.Abs(residueScript)
	bin := fakeBin(t, "ast-grep", "exit 0\n")
	cmd := exec.Command("/bin/sh", script)
	cmd.Dir = repo
	cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin"}
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "rules dir") {
		t.Errorf("want failure naming the rules dir, got %v %q", err, out)
	}
	if r, ok := gate.Parse(string(out)); !ok || r.Green() {
		t.Errorf("want a non-green gate line: %q", out)
	}
}

func TestTransformWorkflowsCheckResidueBeforeVerify(t *testing.T) {
	for _, name := range []string{"migration", "framework-upgrade", "dep-upgrade"} {
		g, err := graph.Load(filepath.Join(workflowsDir, name+".yml"))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		n, ok := g.Node("residue")
		if !ok || n.Kind != graph.KindCheck || !strings.Contains(n.Run, "ast-grep-residue") {
			t.Fatalf("%s: want a residue check node running the pack, got %+v", name, n)
		}
		verify := ""
		for _, v := range g.Nodes() {
			if v.Uses == "verify" {
				verify = v.ID
			}
		}
		if to, err := g.Next("residue", graph.Pass); err != nil || to != verify {
			t.Errorf("%s: residue passes to %q (%v), want verify %q", name, to, err, verify)
		}
		// every check that fed verify now feeds residue first
		for _, e := range g.Edges() {
			if e.To == verify && e.From != "residue" {
				t.Errorf("%s: %s reaches verify without passing residue", name, e.From)
			}
		}
	}
}
