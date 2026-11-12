package crypt_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/store/conformance"
	"github.com/KaaS-team/factory/internal/store/crypt"
)

var key = bytes.Repeat([]byte{7}, crypt.KeySize)

func sqliteStore(t *testing.T) *crypt.SQLite {
	t.Helper()
	s, err := crypt.OpenSQLite(filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func enc(t *testing.T, in crypt.Store) *crypt.Encrypted {
	t.Helper()
	e, err := crypt.New(in, key)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestConformance(t *testing.T) {
	stores := map[string]func(*testing.T) crypt.Store{
		"memory":           func(*testing.T) crypt.Store { return crypt.NewMemory() },
		"sqlite":           func(t *testing.T) crypt.Store { return sqliteStore(t) },
		"encrypted memory": func(t *testing.T) crypt.Store { return enc(t, crypt.NewMemory()) },
		"encrypted sqlite": func(t *testing.T) crypt.Store { return enc(t, sqliteStore(t)) },
	}
	for name, f := range stores {
		t.Run(name, func(t *testing.T) { conformance.Run(t, f) })
	}
}

func TestEncryptedStoresCiphertextWithTag(t *testing.T) {
	ctx := context.Background()
	inner := crypt.NewMemory()
	e := enc(t, inner)
	if err := e.Put(ctx, crypt.Row{Thread: "t", ID: "a", Type: "json", Data: []byte("secret-state")}); err != nil {
		t.Fatal(err)
	}
	raw, _, _ := inner.Get(ctx, "t", "a")
	if raw.Type != "json"+crypt.CipherTag || bytes.Contains(raw.Data, []byte("secret-state")) {
		t.Fatalf("raw row not encrypted: %+v", raw)
	}
}

func TestPlainAndEncryptedRowsBothLoad(t *testing.T) {
	ctx := context.Background()
	inner := crypt.NewMemory()
	_ = inner.Put(ctx, crypt.Row{Thread: "t", ID: "old", Type: "json", Data: []byte("plain")})
	e := enc(t, inner)
	_ = e.Put(ctx, crypt.Row{Thread: "t", ID: "new", Type: "json", Data: []byte("sealed")})
	for id, want := range map[string]string{"old": "plain", "new": "sealed"} {
		r, ok, err := e.Get(ctx, "t", id)
		if err != nil || !ok || string(r.Data) != want || r.Type != "json" {
			t.Fatalf("%s: %+v ok=%v err=%v", id, r, ok, err)
		}
	}
	if r, _, _ := e.Latest(ctx, "t"); string(r.Data) != "sealed" {
		t.Fatalf("latest = %+v", r)
	}
}

func TestDecryptFailures(t *testing.T) {
	ctx := context.Background()
	cases := map[string]func(inner *crypt.Memory) crypt.Store{
		"wrong key": func(in *crypt.Memory) crypt.Store {
			s, _ := crypt.New(in, bytes.Repeat([]byte{9}, crypt.KeySize))
			return s
		},
		"moved row": func(in *crypt.Memory) crypt.Store {
			r, _, _ := in.Get(ctx, "t", "a")
			r.ID = "b"
			_ = in.Put(ctx, r)
			return enc(t, in)
		},
		"truncated": func(in *crypt.Memory) crypt.Store {
			_ = in.Put(ctx, crypt.Row{Thread: "t", ID: "a", Type: "json" + crypt.CipherTag, Data: []byte("x")})
			return enc(t, in)
		},
	}
	for name, mk := range cases {
		t.Run(name, func(t *testing.T) {
			in := crypt.NewMemory()
			_ = enc(t, in).Put(ctx, crypt.Row{Thread: "t", ID: "a", Type: "json", Data: []byte("v")})
			s := mk(in)
			id := "a"
			if name == "moved row" {
				id = "b"
			}
			if _, _, err := s.Get(ctx, "t", id); err == nil {
				t.Fatal("want error")
			}
		})
	}
}

func TestNewRejectsShortKey(t *testing.T) {
	if _, err := crypt.New(crypt.NewMemory(), []byte("short")); err == nil {
		t.Fatal("want error")
	}
}

func TestLoadKey(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, b []byte, mode os.FileMode) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	hexKey := strings.Repeat("ab", crypt.KeySize) + "\n"
	cases := []struct {
		name string
		path string
		ok   bool
	}{
		{"raw", write("raw", key, 0o600), true},
		{"hex", write("hex", []byte(hexKey), 0o600), true},
		{"short", write("short", []byte("abc"), 0o600), false},
		{"group readable", write("open", key, 0o644), false},
		{"missing", filepath.Join(dir, "none"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			k, err := crypt.LoadKey(c.path)
			if (err == nil) != c.ok || (c.ok && len(k) != crypt.KeySize) {
				t.Fatalf("key len %d err=%v", len(k), err)
			}
		})
	}
}
