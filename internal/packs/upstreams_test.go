package packs

import (
	"os"
	"testing"
)

func TestFromUpstreamsConvertsEveryEntry(t *testing.T) {
	data, err := os.ReadFile("testdata/upstreams.json")
	if err != nil {
		t.Fatal(err)
	}
	entries, err := FromUpstreams(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 24 {
		t.Fatalf("want 24 entries (one per file in the fixture), got %d", len(entries))
	}
	lock := NewLock()
	for _, e := range entries {
		if err := CheckLicence(e.Licence); err != nil {
			t.Error(err)
		}
		if err := lock.Put(e); err != nil {
			t.Error(err)
		}
	}
	b, err := lock.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseLock(b); err != nil {
		t.Fatal(err)
	}
}

func TestFromUpstreamsRejects(t *testing.T) {
	for _, in := range []string{`[`, `[{"repo":"a/b","sha":"abcdef1","licence":"MIT","files":[{"from":"x","to":"misc/x","sha256":"s"}]}]`,
		`[{"repo":"a/b","sha":"abcdef1","licence":"MIT","files":[{"from":"x","to":"skills/x","sha256":""}]}]`,
		`[{"repo":"bad","sha":"abcdef1","licence":"MIT","files":[{"from":"x","to":"skills/x","sha256":"s"}]}]`} {
		if _, err := FromUpstreams([]byte(in)); err == nil {
			t.Errorf("%s accepted", in)
		}
	}
}
