package migration

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestLoadSamplePack(t *testing.T) {
	b, err := os.ReadFile("testdata/react-bump.yaml")
	if err != nil {
		t.Fatal(err)
	}
	p, err := Load(b)
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "example.react.Bump18" || len(p.Steps) != 3 || len(p.Preconditions) != 1 {
		t.Fatalf("unexpected pack: %+v", p)
	}
}

func TestLoadRejects(t *testing.T) {
	const head = "type: specs.factory/migration\nname: a.b.C\ndescription: d\n"
	cases := []struct{ name, doc, want string }{
		{"unknown top field", head + "colour: red\nsteps: [{name: s, run: [x]}]\n", "colour"},
		{"unknown step field", head + "steps: [{name: s, run: [x], retries: 3}]\n", "retries"},
		{"wrong type", strings.Replace(head, "specs.factory/migration", "specs.openrewrite.org/v1beta/recipe", 1) + "steps: [{name: s, run: [x]}]\n", "type"},
		{"bad name", strings.Replace(head, "a.b.C", "not a name", 1) + "steps: [{name: s, run: [x]}]\n", "name"},
		{"no description", "type: specs.factory/migration\nname: a.b.C\nsteps: [{name: s, run: [x]}]\n", "description"},
		{"no steps", head, "steps"},
		{"step without action", head + "steps: [{name: s}]\n", "exactly one of run, prompt, steps"},
		{"step with two actions", head + "steps: [{name: s, run: [x], prompt: p}]\n", "exactly one of run, prompt, steps"},
		{"step without name", head + "steps: [{run: [x]}]\n", "name"},
		{"duplicate step name", head + "steps: [{name: s, run: [x]}, {name: s, run: [y]}]\n", "duplicate"},
		{"unknown predicate", head + "preconditions: [{regex: x}]\nsteps: [{name: s, run: [x]}]\n", "regex"},
		{"two keys in predicate", head + "preconditions: [{glob: x, contains: y}]\nsteps: [{name: s, run: [x]}]\n", "one key"},
		{"bad contains regex", head + "steps: [{name: s, run: [x], files: [{contains: '('}]}]\n", "contains"},
		{"bad version range", head + "steps: [{name: s, run: [x], files: [{dependency: {name: a, version: 'banana'}}]}]\n", "version"},
		{"dependency without name", head + "steps: [{name: s, run: [x], files: [{dependency: {version: '>=1'}}]}]\n", "name"},
		{"unknown dependency field", head + "steps: [{name: s, run: [x], files: [{dependency: {name: a, extra: 1}}]}]\n", "extra"},
		{"nested steps validated", head + "steps: [{name: g, steps: [{name: n}]}]\n", "exactly one of"},
		{"empty run", head + "steps: [{name: s, run: []}]\n", "exactly one of"},
		{"not yaml", "a: [", "yaml"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Load([]byte(c.doc))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want error containing %q, got %v", c.want, err)
			}
		})
	}
}

func TestLoadNestedSteps(t *testing.T) {
	p, err := Load([]byte("type: specs.factory/migration\nname: a.b.C\ndescription: d\nsteps:\n  - name: group\n    steps:\n      - {name: one, run: [x]}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Flatten(); len(got) != 1 || got[0].Path != "group/one" {
		t.Fatalf("flatten: %+v", got)
	}
}

func TestSchemaDocumentsEveryField(t *testing.T) {
	b, err := os.ReadFile("doc.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range schemaFields() {
		if !strings.Contains(string(b), f) {
			t.Errorf("doc.go does not document %q", f)
		}
	}
}

// SchemaFields lists every yaml key the schema accepts.
func schemaFields() []string {
	var out []string
	for _, t := range []reflect.Type{reflect.TypeFor[Pack](), reflect.TypeFor[Step](), reflect.TypeFor[Dependency]()} {
		for i := range t.NumField() {
			if tag := t.Field(i).Tag.Get("yaml"); tag != "" {
				out = append(out, tag)
			}
		}
	}
	return append(out, "and", "or", "not", "glob", "contains", "dependency")
}
