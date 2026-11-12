package packs

import (
	"reflect"
	"strings"
	"testing"
)

func TestPathMatchesGlob(t *testing.T) {
	tests := []struct {
		pattern, path string
		want          bool
	}{
		{"*.go", "main.go", true},
		{"*.go", "internal/packs/a.go", true},
		{"*.go", "a.gox", false},
		{"internal/*.go", "internal/a.go", true},
		{"internal/*.go", "internal/packs/a.go", false},
		{"internal/**", "internal/packs/a.go", true},
		{"internal/**/a.go", "internal/a.go", true},
		{"internal/**/a.go", "internal/x/y/a.go", true},
		{"src/?.ts", "src/a.ts", true},
		{"src/?.ts", "src/ab.ts", false},
		{"src/?.ts", "src//.ts", false},
		{"a.b", "aXb", false},
		{"", "a", false},
	}
	for _, tc := range tests {
		if got := PathMatchesGlob(tc.path, tc.pattern); got != tc.want {
			t.Errorf("PathMatchesGlob(%q, %q) = %v, want %v", tc.path, tc.pattern, got, tc.want)
		}
	}
}

func TestKeywordMatches(t *testing.T) {
	tests := []struct {
		kw, msg string
		want    bool
	}{
		{"git", "use git here", true},
		{"git", "open github", false},
		{"issue", "a tissue", false},
		{"Issue", "fix the ISSUE.", true},
		{"/linear", "run /linear now", true},
		{"", "anything", false},
	}
	for _, tc := range tests {
		if got := KeywordMatches(tc.kw, tc.msg); got != tc.want {
			t.Errorf("KeywordMatches(%q, %q) = %v, want %v", tc.kw, tc.msg, got, tc.want)
		}
	}
}

func TestParseManifestTriggers(t *testing.T) {
	m, err := ParseManifest([]byte("name: s\nkind: skill\npaths: ['**/*.sql']\nkeywords: [migrate]\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(m.Paths, []string{"**/*.sql"}) || !reflect.DeepEqual(m.Keywords, []string{"migrate"}) {
		t.Fatalf("%+v", m)
	}
	for _, bad := range []string{"paths: ['']", "keywords: ['']"} {
		if _, err := ParseManifest([]byte("name: s\nkind: skill\n" + bad + "\n")); err == nil {
			t.Errorf("%s: want an error", bad)
		}
	}
}

func TestSkillBodyInjectedOnlyOnMatch(t *testing.T) {
	always := Manifest{Name: "always", Kind: KindSkill}
	byPath := Manifest{Name: "sql", Kind: KindSkill, Paths: []string{"**/*.sql"}}
	byWord := Manifest{Name: "mig", Kind: KindSkill, Keywords: []string{"migrate"}}
	agent := Manifest{Name: "ag", Kind: KindAgent, Paths: []string{"*.go"}}
	all := []Manifest{always, byPath, byWord, agent}
	tests := []struct {
		name  string
		paths []string
		text  string
		want  []string
	}{
		{"nothing touched", nil, "hello", []string{"always"}},
		{"path match", []string{"db/x.sql"}, "hello", []string{"always", "sql"}},
		{"keyword match", nil, "please migrate it", []string{"always", "mig"}},
		{"both", []string{"a.sql"}, "migrate", []string{"always", "sql", "mig"}},
		{"keyword is whole token", nil, "migrates", []string{"always"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			for _, m := range Inject(all, tc.paths, tc.text) {
				got = append(got, m.Name)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

// Three fixtures: the old rule injects every skill body; the trigger rule injects the matching ones.
// Each task must still get every skill it needs (the pass-rate proxy) with fewer tokens.
func TestTriggersCutTokensWithoutDroppingNeededSkills(t *testing.T) {
	body := func(n int) string { return strings.Repeat("rule text ", n) }
	skills := []Manifest{
		{Name: "go", Kind: KindSkill, Paths: []string{"*.go"}},
		{Name: "sql", Kind: KindSkill, Paths: []string{"**/*.sql"}},
		{Name: "docs", Kind: KindSkill, Keywords: []string{"readme", "docs"}},
		{Name: "core", Kind: KindSkill},
	}
	bodies := map[string]string{"go": body(200), "sql": body(300), "docs": body(150), "core": body(50)}
	fixtures := []struct {
		task  string
		paths []string
		text  string
		need  []string
	}{
		{"fix a go bug", []string{"internal/a.go"}, "fix the bug", []string{"go", "core"}},
		{"add a migration", []string{"db/001.sql"}, "add a column", []string{"sql", "core"}},
		{"update the readme", nil, "update the readme", []string{"docs", "core"}},
	}
	for _, f := range fixtures {
		before, after := 0, 0
		for _, s := range skills {
			before += len(bodies[s.Name]) / 4
		}
		got := map[string]bool{}
		for _, s := range Inject(skills, f.paths, f.text) {
			after += len(bodies[s.Name]) / 4
			got[s.Name] = true
		}
		for _, n := range f.need {
			if !got[n] {
				t.Errorf("%s: needed skill %s not injected", f.task, n)
			}
		}
		if after >= before {
			t.Errorf("%s: tokens %d -> %d, want fewer", f.task, before, after)
		}
		t.Logf("%s: ~%d tokens before, ~%d after", f.task, before, after)
	}
}
