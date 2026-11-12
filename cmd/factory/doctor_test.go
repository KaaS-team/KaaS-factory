package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeBin writes an executable shell script named name into dir.
func fakeBin(t *testing.T, dir, name, script string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// doctorEnv gives a working directory and a PATH holding only the named fake tools.
func doctorEnv(t *testing.T, tools map[string]string) {
	t.Helper()
	t.Chdir(t.TempDir())
	bin := t.TempDir()
	for n, s := range tools {
		fakeBin(t, bin, n, s)
	}
	t.Setenv("PATH", bin)
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); strings.HasPrefix(k, "ANTHROPIC_") {
			t.Setenv(k, "")
			_ = os.Unsetenv(k)
		}
	}
}

func TestDoctor(t *testing.T) {
	all := map[string]string{"git": "exit 0", "gh": "exit 0", "claude": "exit 0", "go": "exit 0"}
	without := func(name string) map[string]string {
		m := map[string]string{}
		for k, v := range all {
			if k != name {
				m[k] = v
			}
		}
		return m
	}
	ghOut := map[string]string{"git": "exit 0", "gh": "exit 1", "claude": "exit 0", "go": "exit 0"}
	for _, tc := range []struct {
		name  string
		tools map[string]string
		env   map[string]string
		want  string // substring of output
		fail  bool
	}{
		{"all present", all, nil, "pass\tgit", false},
		{"git missing", without("git"), nil, "fail\tgit\tgit not found", true},
		{"gh missing", without("gh"), nil, "fail\tgh\tgh not found", true},
		{"gh logged out", ghOut, nil, "fail\tgh\tgh is not logged in", true},
		{"claude missing", without("claude"), nil, "fail\tclaude\tclaude not found", true},
		{"go missing only warns", without("go"), nil, "warn\tgo", false},
		{"config does not load", all, map[string]string{"FACTORY_SLOTS": "many"}, "fail\tconfig", true},
		{"ANTHROPIC_API_KEY set", all, map[string]string{"ANTHROPIC_API_KEY": "x"}, "ANTHROPIC_API_KEY set", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doctorEnv(t, tc.tools)
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			out, _, err := runCLI(t, "doctor")
			if !strings.Contains(out, tc.want) {
				t.Fatalf("output lacks %q:\n%s", tc.want, out)
			}
			if tc.fail != (err != nil) {
				t.Fatalf("fail = %v, err = %v", tc.fail, err)
			}
			if tc.fail && !strings.Contains(out, "\tfix: ") {
				t.Fatalf("failing row has no fix line:\n%s", out)
			}
		})
	}
}

func TestDoctorAllGreenHasNoFailRows(t *testing.T) {
	doctorEnv(t, map[string]string{"git": "exit 0", "gh": "exit 0", "claude": "exit 0", "go": "exit 0"})
	out, _, err := runCLI(t, "doctor")
	if err != nil || strings.Contains(out, "fail") || strings.Contains(out, "warn") {
		t.Fatalf("err = %v\n%s", err, out)
	}
}
