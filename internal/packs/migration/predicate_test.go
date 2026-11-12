package migration

import (
	"testing"
	"testing/fstest"
)

func repo() fstest.MapFS {
	return fstest.MapFS{
		"package.json":     {Data: []byte(`{"dependencies":{"react":"^17.0.2"},"devDependencies":{"jest":"29.1.0"}}`)},
		"go.mod":           {Data: []byte("module x\n\ngo 1.26\n\nrequire (\n\tgithub.com/spf13/cobra v1.10.2\n\tgolang.org/x/net v0.60.0 // indirect\n)\n\nrequire github.com/a/b v1.0.0\n")},
		"src/app.tsx":      {Data: []byte("ReactDOM.render(<App/>, el)")},
		"src/deep/x/b.tsx": {Data: []byte("export const b = 1")},
		"src/app.test.tsx": {Data: []byte("it('x')")},
		"README.md":        {Data: []byte("hello")},
	}
}

func pred(t *testing.T, doc string) Predicate {
	t.Helper()
	p, err := Load([]byte("type: specs.factory/migration\nname: a.b\ndescription: d\nsteps:\n  - name: s\n    run: [x]\n    files: [" + doc + "]\n"))
	if err != nil {
		t.Fatal(err)
	}
	return p.Steps[0].Files[0]
}

func TestPredicates(t *testing.T) {
	cases := []struct {
		name, doc, file string
		want            bool
	}{
		{"glob star in dir", `{glob: "src/*.tsx"}`, "src/app.tsx", true},
		{"glob star stops at slash", `{glob: "src/*.tsx"}`, "src/deep/x/b.tsx", false},
		{"glob doublestar crosses", `{glob: "src/**/*.tsx"}`, "src/deep/x/b.tsx", true},
		{"glob doublestar matches none-deep", `{glob: "src/**/*.tsx"}`, "src/app.tsx", true},
		{"glob trailing doublestar", `{glob: "src/**"}`, "src/deep/x/b.tsx", true},
		{"glob question mark", `{glob: "README.m?"}`, "README.md", true},
		{"glob literal dot is not wild", `{glob: "README.md"}`, "READMEXmd", false},
		{"glob miss", `{glob: "*.go"}`, "README.md", false},
		{"contains hit", `{contains: 'ReactDOM\.render\('}`, "src/app.tsx", true},
		{"contains miss", `{contains: 'createRoot'}`, "src/app.tsx", false},
		{"contains unreadable file is false", `{contains: 'x'}`, "missing.txt", false},
		{"dependency present", `{dependency: {name: react}}`, "README.md", true},
		{"dependency absent", `{dependency: {name: vue}}`, "README.md", false},
		{"dependency dev", `{dependency: {name: jest}}`, "README.md", true},
		{"dependency in range", `{dependency: {name: react, version: ">=17.0.0 <18.0.0"}}`, "README.md", true},
		{"dependency below range", `{dependency: {name: react, version: ">=18"}}`, "README.md", false},
		{"dependency at upper bound excluded", `{dependency: {name: react, version: "<17.0.2"}}`, "README.md", false},
		{"dependency exact", `{dependency: {name: jest, version: "29.1.0"}}`, "README.md", true},
		{"dependency not equal", `{dependency: {name: jest, version: "!=29.1.0"}}`, "README.md", false},
		{"go.mod require block", `{dependency: {name: github.com/spf13/cobra, version: ">=1.10"}}`, "README.md", true},
		{"go.mod indirect", `{dependency: {name: golang.org/x/net, manifest: go.mod}}`, "README.md", true},
		{"go.mod single require", `{dependency: {name: github.com/a/b, manifest: go.mod, version: "<=1.0.0"}}`, "README.md", true},
		{"manifest pinned excludes other", `{dependency: {name: react, manifest: go.mod}}`, "README.md", false},
		{"and all true", `{and: [{glob: "src/**"}, {contains: render}]}`, "src/app.tsx", true},
		{"and one false", `{and: [{glob: "src/**"}, {contains: nope}]}`, "src/app.tsx", false},
		{"or one true", `{or: [{glob: "*.go"}, {contains: render}]}`, "src/app.tsx", true},
		{"or none true", `{or: [{glob: "*.go"}, {contains: nope}]}`, "src/app.tsx", false},
		{"not flips true", `{not: {glob: "*.go"}}`, "src/app.tsx", true},
		{"not flips false", `{not: {glob: "src/**"}}`, "src/app.tsx", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := pred(t, c.doc).Match(repo(), c.file)
			if err != nil || got != c.want {
				t.Fatalf("got %v, %v; want %v", got, err, c.want)
			}
		})
	}
}

func TestMalformedManifestIsAnError(t *testing.T) {
	fsys := fstest.MapFS{"package.json": {Data: []byte("{")}}
	if _, err := pred(t, `{dependency: {name: react}}`).Match(fsys, "a"); err == nil {
		t.Fatal("want an error for a broken package.json")
	}
}

func TestMissingManifestIsFalse(t *testing.T) {
	got, err := pred(t, `{dependency: {name: react}}`).Match(fstest.MapFS{}, "a")
	if err != nil || got {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestVersionParsing(t *testing.T) {
	for in, want := range map[string]version{"1": {1, 0, 0}, "v1.2": {1, 2, 0}, "^17.0.2": {17, 0, 2}, "~1.2.3-beta.1": {1, 2, 3}, "2.0.0+build": {2, 0, 0}} {
		if got, err := parseVersion(in); err != nil || got != want {
			t.Errorf("%s: got %v, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "1.2.3.4", "a.b", "-1"} {
		if _, err := parseVersion(bad); err == nil {
			t.Errorf("%q: want error", bad)
		}
	}
}
