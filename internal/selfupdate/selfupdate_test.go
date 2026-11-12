package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeSource struct {
	latest string
	files  map[string][]byte
}

func (f fakeSource) Latest(context.Context) (Release, error) { return Release{Version: f.latest}, nil }
func (f fakeSource) Asset(_ context.Context, v, name string) ([]byte, error) {
	b, ok := f.files[v+"/"+name]
	if !ok {
		return nil, errors.New("not found")
	}
	return b, nil
}

func archive(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	_, _ = tw.Write(content)
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func sum(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func release(t *testing.T, ver string, content []byte, checksum string) fakeSource {
	t.Helper()
	a := archive(t, "factory", content)
	name := AssetName(ver, "linux", "amd64")
	if checksum == "" {
		checksum = sum(a)
	}
	return fakeSource{latest: ver, files: map[string][]byte{
		ver + "/" + name:       a,
		ver + "/checksums.txt": []byte(checksum + "  " + name + "\n"),
	}}
}

func TestCheck(t *testing.T) {
	rows := []struct {
		name, current, latest string
		want                  bool
		err                   bool
	}{
		{"newer patch", "v1.2.3", "v1.2.4", true, false},
		{"newer minor beats patch", "v1.2.9", "v1.3.0", true, false},
		{"same", "v1.2.3", "v1.2.3", false, false},
		{"older latest", "v2.0.0", "v1.9.9", false, false},
		{"dev build updates", "dev", "v0.1.0", true, false},
		{"bad latest", "v1.0.0", "latest", false, true},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			rel, ok, err := Check(context.Background(), r.current, fakeSource{latest: r.latest})
			if (err != nil) != r.err || ok != r.want || (!r.err && rel.Version != r.latest) {
				t.Fatalf("rel %v ok %v err %v", rel, ok, err)
			}
		})
	}
}

func installed(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "factory")
	if err := os.WriteFile(p, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestApplyReplacesBinary(t *testing.T) {
	exe := installed(t)
	src := release(t, "v1.0.1", []byte("new binary"), "")
	if err := Apply(context.Background(), Release{Version: "v1.0.1"}, src, exe, "linux", "amd64"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new binary" {
		t.Fatalf("binary = %q", b)
	}
	if st, _ := os.Stat(exe); st.Mode().Perm()&0o111 == 0 {
		t.Fatal("not executable")
	}
	ents, _ := os.ReadDir(filepath.Dir(exe))
	if len(ents) != 1 {
		t.Fatalf("temp file left behind: %v", ents)
	}
}

// The replacement is a rename of a temp file made in the same directory, so
// the running inode is never written in place: a hard link to the old binary
// keeps its old content.
func TestApplyRenamesInSameDirectory(t *testing.T) {
	exe := installed(t)
	link := exe + ".old"
	if err := os.Link(exe, link); err != nil {
		t.Skip("hard links unavailable")
	}
	src := release(t, "v1.0.1", []byte("new"), "")
	if err := Apply(context.Background(), Release{Version: "v1.0.1"}, src, exe, "linux", "amd64"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(link); string(b) != "old" {
		t.Fatalf("old inode was rewritten: %q", b)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new" {
		t.Fatalf("exe = %q", b)
	}
}

func TestApplyRefusesAndKeepsOldBinary(t *testing.T) {
	good := release(t, "v1.0.1", []byte("new"), "")
	name := AssetName("v1.0.1", "linux", "amd64")
	rows := []struct {
		name, want string
		src        fakeSource
		goos       string
	}{
		{"sha256 mismatch", "checksum mismatch", release(t, "v1.0.1", []byte("new"), strings.Repeat("0", 64)), "linux"},
		{"bad checksum text", "invalid checksum", release(t, "v1.0.1", []byte("new"), "zz"), "linux"},
		{"asset not listed", "does not contain", fakeSource{files: map[string][]byte{"v1.0.1/checksums.txt": []byte("x")}}, "linux"},
		{"no archive", "download release archive", fakeSource{files: map[string][]byte{"v1.0.1/checksums.txt": good.files["v1.0.1/checksums.txt"]}}, "linux"},
		{"no checksums", "download checksums", fakeSource{files: map[string][]byte{"v1.0.1/" + name: good.files["v1.0.1/"+name]}}, "linux"},
		{"unsupported os", "unsupported operating system", good, "plan9"},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			exe := installed(t)
			err := Apply(context.Background(), Release{Version: "v1.0.1"}, r.src, exe, r.goos, "amd64")
			if err == nil || !strings.Contains(err.Error(), r.want) {
				t.Fatalf("err = %v", err)
			}
			if b, _ := os.ReadFile(exe); string(b) != "old" {
				t.Fatalf("old binary changed: %q", b)
			}
		})
	}
	t.Run("archive without binary", func(t *testing.T) {
		a := archive(t, "other", []byte("x"))
		n := AssetName("v1.0.1", "linux", "amd64")
		src := fakeSource{files: map[string][]byte{"v1.0.1/" + n: a, "v1.0.1/checksums.txt": []byte(sum(a) + " " + n)}}
		if err := Apply(context.Background(), Release{Version: "v1.0.1"}, src, installed(t), "linux", "amd64"); err == nil {
			t.Fatal("want error")
		}
	})
	t.Run("bad version and arch", func(t *testing.T) {
		if Apply(context.Background(), Release{Version: "x"}, good, installed(t), "linux", "amd64") == nil ||
			Apply(context.Background(), Release{Version: "v1.0.1"}, good, installed(t), "linux", "386") == nil {
			t.Fatal("want errors")
		}
	})
}

func TestGitHubSourceAgainstLocalServer(t *testing.T) {
	a := archive(t, "factory", []byte("served"))
	n := AssetName("v2.0.0", "linux", "amd64")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/releases/latest":
			_, _ = fmt.Fprint(w, `{"tag_name":"v2.0.0"}`)
		case "/dl/v2.0.0/checksums.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n", sum(a), n)
		case "/dl/v2.0.0/" + n:
			_, _ = w.Write(a)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	src := GitHubSource{APIBase: srv.URL + "/api", ReleaseBase: srv.URL + "/dl"}
	rel, ok, err := Check(context.Background(), "v1.0.0", src)
	if err != nil || !ok || rel.Version != "v2.0.0" {
		t.Fatal(rel, ok, err)
	}
	exe := installed(t)
	if err := Apply(context.Background(), rel, src, exe, "linux", "amd64"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "served" {
		t.Fatalf("exe = %q", b)
	}
	if _, err := src.Asset(context.Background(), "v9.9.9", "x"); err == nil {
		t.Fatal("want 404 error")
	}
}
