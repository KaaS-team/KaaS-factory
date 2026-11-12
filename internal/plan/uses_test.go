package plan

import (
	"reflect"
	"testing"
)

func TestBodyUsesFiles(t *testing.T) {
	body := "<!-- factory:planned v1 -->\n\n## Files\n- `a.go`\n\n## Uses\n- `internal/x.go`\n- `docs/y.md`\n\n## Acceptance\n- AC-1: ok\n"
	tk, err := NewTicket("T1", "t", body)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"internal/x.go", "docs/y.md"}; !reflect.DeepEqual(tk.UsesFiles, want) {
		t.Errorf("UsesFiles = %v, want %v", tk.UsesFiles, want)
	}
	if !reflect.DeepEqual(tk.Files, []string{"a.go"}) {
		t.Errorf("Files = %v", tk.Files)
	}
	none, _ := NewTicket("T2", "t", "<!-- factory:planned v1 -->\n\n## Files\n- `a.go`\n")
	if len(none.UsesFiles) != 0 {
		t.Errorf("no Uses section gave %v", none.UsesFiles)
	}
}

func TestFilterUses(t *testing.T) {
	repo := map[string]bool{"a.go": true, "pkg/b.go": true}
	tests := []struct {
		name          string
		in, kept, drp []string
	}{
		{"all exist", []string{"a.go", "pkg/b.go"}, []string{"a.go", "pkg/b.go"}, nil},
		{"missing dropped", []string{"a.go", "nope.go"}, []string{"a.go"}, []string{"nope.go"}},
		{"cleaned and deduped", []string{"./a.go", "pkg/../a.go", "a.go"}, []string{"a.go"}, nil},
		{"outside the repo", []string{"../etc/passwd", "/abs/a.go", ".."}, nil, []string{"../etc/passwd", "/abs/a.go", ".."}},
		{"empty", nil, nil, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			k, d := FilterUses(tc.in, func(p string) bool { return repo[p] })
			if !reflect.DeepEqual(k, tc.kept) || !reflect.DeepEqual(d, tc.drp) {
				t.Errorf("kept %v dropped %v, want %v %v", k, d, tc.kept, tc.drp)
			}
		})
	}
}

func TestUsesMetric(t *testing.T) {
	if got, want := UsesMetric("T1", 5, 3), "uses_files ticket=T1 offered=5 read=3"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
