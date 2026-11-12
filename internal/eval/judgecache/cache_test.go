package judgecache

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeJudge struct {
	calls int
	err   error
}

func (f *fakeJudge) Judge(_ context.Context, r Request) (Verdict, error) {
	f.calls++
	if f.err != nil {
		return Verdict{}, f.err
	}
	return Verdict{Pass: true, Score: 0.9, Reason: "ok " + r.Fixture}, nil
}

func TestSecondRunMakesZeroJudgeCalls(t *testing.T) {
	dir := t.TempDir()
	f := &fakeJudge{}
	req := Request{Fixture: "fx", Output: "out", RubricVersion: Version("be kind")}
	first, err := New(dir, f).Judge(context.Background(), req)
	if err != nil || first.Cached || f.calls != 1 {
		t.Fatalf("first: %+v err=%v calls=%d", first, err, f.calls)
	}
	// A new Cache on the same directory is a second run of the process.
	second, err := New(dir, f).Judge(context.Background(), req)
	if err != nil || !second.Cached || f.calls != 1 {
		t.Fatalf("second: %+v err=%v calls=%d", second, err, f.calls)
	}
	if second.Verdict != first.Verdict {
		t.Fatalf("verdict changed: %+v vs %+v", second.Verdict, first.Verdict)
	}
}

func TestKeyInvalidation(t *testing.T) {
	base := Request{Fixture: "fx", Output: "out", RubricVersion: Version("v1")}
	cases := []struct {
		name string
		req  Request
	}{
		{"rubric edit", Request{Fixture: "fx", Output: "out", RubricVersion: Version("v2")}},
		{"output change", Request{Fixture: "fx", Output: "out2", RubricVersion: Version("v1")}},
		{"fixture change", Request{Fixture: "fy", Output: "out", RubricVersion: Version("v1")}},
		{"field boundary", Request{Fixture: "fxo", Output: "ut", RubricVersion: Version("v1")}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeJudge{}
			cache := New(t.TempDir(), f)
			if _, err := cache.Judge(context.Background(), base); err != nil {
				t.Fatal(err)
			}
			r, err := cache.Judge(context.Background(), c.req)
			if err != nil || r.Cached || f.calls != 2 {
				t.Fatalf("%+v err=%v calls=%d", r, err, f.calls)
			}
		})
	}
}

func TestJudgeErrorIsNotCached(t *testing.T) {
	f := &fakeJudge{err: errors.New("down")}
	cache := New(t.TempDir(), f)
	req := Request{Fixture: "a", Output: "b", RubricVersion: "c"}
	if _, err := cache.Judge(context.Background(), req); err == nil {
		t.Fatal("want error")
	}
	f.err = nil
	r, err := cache.Judge(context.Background(), req)
	if err != nil || r.Cached || f.calls != 2 {
		t.Fatalf("%+v err=%v calls=%d", r, err, f.calls)
	}
}

func TestCorruptEntryIsAMiss(t *testing.T) {
	dir := t.TempDir()
	f := &fakeJudge{}
	req := Request{Fixture: "a", Output: "b", RubricVersion: "c"}
	if err := writeFile(entryPath(dir, req), []byte("{not json")); err != nil {
		t.Fatal(err)
	}
	r, err := New(dir, f).Judge(context.Background(), req)
	if err != nil || r.Cached || f.calls != 1 {
		t.Fatalf("%+v err=%v calls=%d", r, err, f.calls)
	}
}

func TestMarker(t *testing.T) {
	if Marker(Result{Cached: true}) != "cached" || Marker(Result{}) != "" {
		t.Fatal("marker")
	}
	if !strings.Contains(Row("fx/T1", Result{Cached: true}), "cached") || strings.Contains(Row("fx/T1", Result{}), "cached") {
		t.Fatal("row")
	}
}
