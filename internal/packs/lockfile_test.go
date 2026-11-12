package packs

import (
	"errors"
	"strings"
	"testing"
)

const sha1 = "0123456789abcdef0123456789abcdef01234567"

func entry(kind Kind, path string) Entry {
	return Entry{Kind: kind, Ref: "o/r@" + sha1 + "#" + path, SHA: sha1, SHA256: strings.Repeat("a", 64), Licence: "MIT"}
}

func TestLockMarshalSortedVersionedWithHeader(t *testing.T) {
	l := NewLock()
	l.Entries = []Entry{entry(KindSkill, "z.md"), entry(KindAgent, "b.md"), entry(KindSkill, "a.md")}
	b, err := l.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
	if !strings.HasPrefix(lines[0], "# ") || !strings.Contains(string(b), "always commit it") {
		t.Fatalf("header must tell agents to commit the file: %q", lines[0])
	}
	if lines[3] != `[["version","2"]]` {
		t.Fatalf("version line = %q", lines[3])
	}
	body := lines[4:]
	if len(body) != 3 || !strings.Contains(body[0], `"agent"`) || !strings.Contains(body[1], "a.md") || !strings.Contains(body[2], "z.md") {
		t.Fatalf("entries not sorted by kind then ref: %q", body)
	}
	back, err := ParseLock(b)
	if err != nil {
		t.Fatal(err)
	}
	b2, _ := back.Marshal()
	if string(b2) != string(b) {
		t.Fatal("round trip not byte identical")
	}
}

func TestParseLockMergeConflict(t *testing.T) {
	in := "[[\"version\",\"2\"]]\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> branch\n"
	if _, err := ParseLock([]byte(in)); !errors.Is(err, ErrMergeConflict) {
		t.Fatalf("want ErrMergeConflict, got %v", err)
	}
}

func TestParseLockUnsupportedVersion(t *testing.T) {
	if _, err := ParseLock([]byte(`[["version","3"]]` + "\n")); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("want unsupported version error, got %v", err)
	}
}

func TestParseLockReadsLegacyJSONAndUpgradesOnWrite(t *testing.T) {
	legacy := `{"version":1,"entries":[{"kind":"skill","ref":"o/r@` + sha1 + `#x.md","sha":"` + sha1 +
		`","sha256":"` + strings.Repeat("b", 64) + `","licence":"MIT","eval_score":0.5}]}` + "\n"
	l, err := ParseLock([]byte(legacy))
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Entries) != 1 || l.Entries[0].EvalScore == nil || *l.Entries[0].EvalScore != 0.5 {
		t.Fatalf("legacy entry lost: %+v", l.Entries)
	}
	b, _ := l.Marshal()
	if !strings.Contains(string(b), `[["version","2"]]`) {
		t.Fatalf("write must upgrade to v2: %s", b)
	}
	back, err := ParseLock(b)
	if err != nil || back.Entries[0] != l.Entries[0] && (back.Entries[0].EvalScore == nil || *back.Entries[0].EvalScore != 0.5) {
		t.Fatalf("score lost on round trip: %v %+v", err, back)
	}
}
