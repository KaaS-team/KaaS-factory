package packs

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeGetter struct {
	files map[string][]byte
	calls int
}

func (f *fakeGetter) Get(_ context.Context, url string) ([]byte, error) {
	f.calls++
	b, ok := f.files[url]
	if !ok {
		return nil, errors.New("404 " + url)
	}
	return b, nil
}

const packURL = "https://example.test/skills/grilling/SKILL.md"

func catalogueFor(body []byte) []byte {
	return []byte(`[{"id":"grilling","kind":"skill","version":"1.0.0","url":"` + packURL + `","sha256":"` + hashHex(body) + `"}]`)
}

func TestInstallRefusesTamperedPackBytes(t *testing.T) {
	good := []byte("# grilling\n")
	e := mustFind(t, catalogueFor(good), "grilling", "1.0.0")
	root := t.TempDir()
	g := &fakeGetter{files: map[string][]byte{packURL: []byte("# grilling\nevil\n")}}
	_, err := Install(context.Background(), g, root, e)
	if !errors.Is(err, ErrPackHash) {
		t.Fatalf("want ErrPackHash, got %v", err)
	}
	if _, err := os.Stat(PackDir(root, "grilling", "1.0.0")); err == nil {
		t.Fatal("tampered bytes were written")
	}
}

func TestVerifyCatalogueSignature(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	data := catalogueFor([]byte("x"))
	sig := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, data)))
	if _, err := VerifyCatalogue(data, sig, pub); err != nil {
		t.Fatalf("good signature refused: %v", err)
	}
	tampered := bytes.Replace(data, []byte("1.0.0"), []byte("9.9.9"), 1)
	if _, err := VerifyCatalogue(tampered, sig, pub); !errors.Is(err, ErrCatalogueSignature) {
		t.Fatalf("bad signature accepted: %v", err)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := VerifyCatalogue(data, sig, other); !errors.Is(err, ErrCatalogueSignature) {
		t.Fatalf("wrong key accepted: %v", err)
	}
	if _, err := VerifyCatalogue(data, sig, nil); err == nil {
		t.Fatal("missing key accepted")
	}
}

func TestInstallTwiceIsNoOp(t *testing.T) {
	body := []byte("# grilling\n")
	e := mustFind(t, catalogueFor(body), "grilling", "1.0.0")
	root := t.TempDir()
	g := &fakeGetter{files: map[string][]byte{packURL: body}}
	r1, err := Install(context.Background(), g, root, e)
	if err != nil || r1.AlreadyInstalled {
		t.Fatalf("first install: %+v %v", r1, err)
	}
	st1, _ := os.Stat(r1.Path)
	r2, err := Install(context.Background(), g, root, e)
	if err != nil || !r2.AlreadyInstalled {
		t.Fatalf("second install: %+v %v", r2, err)
	}
	if g.calls != 1 {
		t.Fatalf("second install downloaded again: %d calls", g.calls)
	}
	st2, _ := os.Stat(r2.Path)
	if !st1.ModTime().Equal(st2.ModTime()) {
		t.Fatal("second install rewrote the file")
	}
}

func TestBlueprintCatalogueAcceptedAsIs(t *testing.T) {
	b := []byte(`[{"id":"grilling","kind":"skill","source":"mattpocock/skills@5863806dd4e15c63174bee4e7515a4256792ecfa#skills/productivity/grilling","licence":"MIT","sha256":"` + strings.Repeat("a", 64) + `","tags":["x"],"eval":"e","score":null},
	{"id":"verifier","kind":"agent","source":"blueprint@550e01384d1c443fff261612c09e38ce0c86997e#plugins/a/verifier.md","sha256":"` + strings.Repeat("b", 64) + `"}]`)
	c, err := ParseCatalogue(b)
	if err != nil {
		t.Fatal(err)
	}
	e, err := c.Find("grilling", "")
	if err != nil || e.PackVersion() != "5863806dd4e15c63174bee4e7515a4256792ecfa" {
		t.Fatalf("%+v %v", e, err)
	}
	u, _ := e.PackURL()
	if u != "https://raw.githubusercontent.com/mattpocock/skills/5863806dd4e15c63174bee4e7515a4256792ecfa/skills/productivity/grilling" {
		t.Fatal(u)
	}
	v, _ := c.Find("verifier", "")
	if u, _ := v.PackURL(); !strings.HasPrefix(u, "https://raw.githubusercontent.com/KaaS-team/blueprint/") {
		t.Fatal(u)
	}
}

func TestInstallCommandEndToEnd(t *testing.T) {
	body := []byte("# grilling\n")
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	cat := filepath.Join(dir, "catalogue.json")
	data := catalogueFor(body)
	_ = os.WriteFile(cat, data, 0o644)
	_ = os.WriteFile(cat+SigSuffix, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, data))), 0o644)
	g := &fakeGetter{files: map[string][]byte{packURL: body}}
	run := func() string {
		c := newInstallCommandWith(g)
		var out bytes.Buffer
		c.SetOut(&out)
		c.SetArgs([]string{"grilling@1.0.0", "--catalogue", cat, "--root", dir, "--pubkey", base64.StdEncoding.EncodeToString(pub)})
		if err := c.Execute(); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	if o := run(); !strings.HasPrefix(o, "installed grilling@1.0.0") {
		t.Fatal(o)
	}
	if o := run(); !strings.Contains(o, "already installed") {
		t.Fatal(o)
	}
}

func mustFind(t *testing.T, cat []byte, name, version string) CatalogueEntry {
	t.Helper()
	c, err := ParseCatalogue(cat)
	if err != nil {
		t.Fatal(err)
	}
	e, err := c.Find(name, version)
	if err != nil {
		t.Fatal(err)
	}
	return e
}
