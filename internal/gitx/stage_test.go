package gitx_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/gitx"
)

func runIn(dir string) func(context.Context, ...string) (string, error) {
	return func(ctx context.Context, args ...string) (string, error) {
		c := exec.CommandContext(ctx, "git", args...)
		c.Dir = dir
		out, err := c.Output()
		return string(out), err
	}
}

func stageRepo(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	run := runIn(d)
	for _, a := range [][]string{{"init", "-q"}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"}} {
		if _, err := run(context.Background(), a...); err != nil {
			t.Fatal(err)
		}
	}
	return d
}

func putFiles(t *testing.T, d string, names ...string) {
	t.Helper()
	for _, n := range names {
		p := filepath.Join(d, n)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStageAllRefusesSecrets(t *testing.T) {
	d := stageRepo(t)
	putFiles(t, d, ".env", "deploy.pem", "main.go", "sub/id_rsa_work", ".env.example")
	err := gitx.StageAll(context.Background(), runIn(d))
	if err == nil {
		t.Fatal("want a refusal")
	}
	for _, w := range []string{".env", "deploy.pem", "sub/id_rsa_work"} {
		if !strings.Contains(err.Error(), w) {
			t.Errorf("error %q lacks %q", err, w)
		}
	}
	staged, _ := runIn(d)(context.Background(), "diff", "--cached", "--name-only")
	for _, s := range []string{".env\n", "deploy.pem", "id_rsa"} {
		if strings.Contains(staged, s) {
			t.Errorf("%q is still staged: %q", s, staged)
		}
	}
}

func TestStageAllStagesSource(t *testing.T) {
	d := stageRepo(t)
	putFiles(t, d, "main.go", ".env.example", "pkg/a.go")
	if err := gitx.StageAll(context.Background(), runIn(d)); err != nil {
		t.Fatal(err)
	}
	staged, _ := runIn(d)(context.Background(), "diff", "--cached", "--name-only")
	for _, s := range []string{"main.go", ".env.example", "pkg/a.go"} {
		if !strings.Contains(staged, s) {
			t.Errorf("%s not staged: %q", s, staged)
		}
	}
}

func TestIsSecretPath(t *testing.T) {
	for p, want := range map[string]bool{".env": true, ".env.local": true, ".env.example": false, "a/b.pem": true, "k.key": true, "id_rsa": true, "id_rsa.pub": true,
		"c.p12": true, "credentials.json": true, "credentials-prod.json": true, ".npmrc": true, ".netrc": true, "env.go": false, "key.go": false} {
		if got := gitx.IsSecretPath(p); got != want {
			t.Errorf("%s: got %v want %v", p, got, want)
		}
	}
}

// Every agent-worktree staging goes through StageAll: a raw "add", "-A" in a non-test source is a bypass.
func TestNoRawAddAll(t *testing.T) {
	root := "../.."
	var found []string
	_ = filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if e.IsDir() && (e.Name() == ".git" || e.Name() == "node_modules" || e.Name() == "src" && p == filepath.Join(root, "src")) {
			return filepath.SkipDir
		}
		if e.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") || strings.HasSuffix(p, "gitx/stage.go") {
			return nil
		}
		b, _ := os.ReadFile(p)
		if strings.Contains(string(b), `"add", "-A"`) {
			found = append(found, p)
		}
		return nil
	})
	if len(found) > 0 {
		t.Fatalf("raw add -A outside gitx.StageAll: %v", found)
	}
}
