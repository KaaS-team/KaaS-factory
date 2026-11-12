package browsercheck

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSkipCopy(t *testing.T) {
	for name, want := range map[string]bool{
		"Cache": true, "Code Cache": true, "GPUCache": true, "DawnCache": true, "DawnGraphiteCache": true,
		"DawnWebGPUCache": true, "GrShaderCache": true, "GraphiteDawnCache": true, "ShaderCache": true,
		"CacheStorage": true, "ScriptCache": true, "SingletonLock": true, "SingletonCookie": true,
		"LOCK": true, "lockfile": true, "DevToolsActivePort": true,
		"Cookies": false, "Preferences": false, "Local Storage": false, "Login Data": false, "cache": false,
	} {
		if got := SkipCopy(name); got != want {
			t.Errorf("SkipCopy(%q) = %v, want %v", name, got, want)
		}
	}
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

func TestCopyProfile(t *testing.T) {
	src, dst := t.TempDir(), filepath.Join(t.TempDir(), "copy")
	write(t, filepath.Join(src, "Local State"), "ls")
	write(t, filepath.Join(src, "Default", "Cookies"), "c")
	write(t, filepath.Join(src, "Default", "Preferences"), "p")
	write(t, filepath.Join(src, "Default", "Cache", "big"), "x")
	write(t, filepath.Join(src, "Default", "Code Cache", "js", "y"), "x")
	write(t, filepath.Join(src, "Default", "Service Worker", "CacheStorage", "z"), "x")
	write(t, filepath.Join(src, "Default", "LOCK"), "x")
	write(t, filepath.Join(src, "Other", "Cookies"), "other profile")
	if err := os.Symlink("Cookies", filepath.Join(src, "Default", "link")); err != nil {
		t.Fatal(err)
	}
	if err := CopyProfile(src, "Default", dst); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"Local State", "Default/Cookies", "Default/Preferences", "Default/link"} {
		if !exists(filepath.Join(dst, p)) {
			t.Errorf("%s was not copied", p)
		}
	}
	for _, p := range []string{"Default/Cache", "Default/Code Cache", "Default/Service Worker/CacheStorage", "Default/LOCK", "Other"} {
		if exists(filepath.Join(dst, p)) {
			t.Errorf("%s was copied", p)
		}
	}
	if l, _ := os.Readlink(filepath.Join(dst, "Default", "link")); l != "Cookies" {
		t.Errorf("symlink target = %q, want Cookies", l)
	}
	if err := CopyProfile(filepath.Join(src, "missing"), "Default", filepath.Join(dst, "x")); err == nil {
		t.Error("a missing source profile must fail")
	}
}

// TestSweepStale is the startup cleanup of symphony-spec section 8.6 for browser temp dirs:
// only dirs of dead owners that are old enough go.
func TestSweepStale(t *testing.T) {
	root := t.TempDir()
	old := time.Now().Add(-time.Hour)
	mk := func(name string, owner bool, mtime time.Time) string {
		d := filepath.Join(root, name)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if owner {
			write(t, filepath.Join(d, ownerFile), "")
			if err := os.Chtimes(filepath.Join(d, ownerFile), mtime, mtime); err != nil {
				t.Fatal(err)
			}
		}
		return d
	}
	dead := mk(TempPrefix+"dead", true, old)
	fresh := mk(TempPrefix+"fresh", true, time.Now())
	noOwner := mk(TempPrefix+"noowner", false, old)
	foreign := mk("other-dir", true, old)
	live := mk(TempPrefix+"live", true, old)
	f, err := os.Open(filepath.Join(live, ownerFile))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if !tryLock(f) {
		t.Skip("file locks unavailable here")
	}
	SweepStale(root, time.Now())
	if exists(dead) {
		t.Error("dead owner's dir survived")
	}
	for name, d := range map[string]string{"fresh": fresh, "no owner file": noOwner, "foreign name": foreign, "live owner": live} {
		if !exists(d) {
			t.Errorf("%s dir was removed", name)
		}
	}
}

// TestRunSweepsAndCleansUp: Run removes a dead owner's dir at start, leaves no dir of its own, and
// still fails, not passes, with no Chrome.
func TestRunSweepsAndCleansUp(t *testing.T) {
	root := t.TempDir()
	stale := filepath.Join(root, TempPrefix+"dead")
	write(t, filepath.Join(stale, ownerFile), "")
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(stale, ownerFile), old, old); err != nil {
		t.Fatal(err)
	}
	res := Run(context.Background(), Options{Steps: []Step{{Kind: "goto", URL: "http://127.0.0.1:1/"}}, OutDir: t.TempDir(), TempRoot: root,
		Look: func(string) (string, error) { return "", errors.New("nope") }})
	if res.Failed != 1 {
		t.Errorf("result %+v", res)
	}
	if left, _ := filepath.Glob(filepath.Join(root, TempPrefix+"*")); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}

// TestRunProfileCopyIsRemoved: with Chrome, the copied profile dir exists while it runs and is gone after.
func TestRunProfileCopyIsRemoved(t *testing.T) {
	chromePath(t)
	srv := server(t)
	root, prof := t.TempDir(), t.TempDir()
	write(t, filepath.Join(prof, "Local State"), "{}")
	write(t, filepath.Join(prof, "Default", "Preferences"), "{}")
	steps, _ := ParseSteps([]byte("- goto: " + srv.URL + "/\n"))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	res := Run(ctx, Options{Steps: steps, OutDir: t.TempDir(), TempRoot: root, Profile: prof, Look: func(string) (string, error) { return chromePath(t), nil }})
	if res.Failed > 0 {
		t.Fatal(res.Message)
	}
	if left, _ := filepath.Glob(filepath.Join(root, TempPrefix+"*")); len(left) != 0 {
		t.Errorf("profile copy left behind: %v", left)
	}
}
