package astgrep

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/pkg/sandbox"
)

type fakeRunner struct {
	out, errOut string
	exit        int
	err         error
	gotDir      string
	gotArgs     []string
}

func (f *fakeRunner) Run(_ context.Context, dir string, args []string) (Result, error) {
	f.gotDir, f.gotArgs = dir, args
	return Result{Stdout: []byte(f.out), Stderr: []byte(f.errOut), Exit: f.exit}, f.err
}

const scanJSON = `[{"text":"console.log(x)","range":{"byteOffset":{"start":0,"end":14},"start":{"line":3,"column":2},"end":{"line":3,"column":16}},
"file":"src/a.ts","lines":"console.log(x)","charCount":{"leading":0,"trailing":0},"language":"TypeScript",
"ruleId":"no-console","severity":"error","note":null,"message":"no console"},
{"text":"var a","range":{"byteOffset":{"start":1,"end":2},"start":{"line":0,"column":0},"end":{"line":0,"column":5}},
"file":"b.ts","lines":"var a","charCount":{"leading":0,"trailing":0},"language":"TypeScript",
"ruleId":"no-var","severity":"warning","note":"use let","message":"no var"}]`

func TestParseFindings(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    int
		wantErr bool
	}{
		{"two findings", scanJSON, 2, false},
		{"empty array", "[]", 0, false},
		{"blank output is no findings", "  \n", 0, false},
		{"not json", "Error: bad", 0, true},
		{"object not array", "{}", 0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ParseFindings([]byte(c.in))
			if (err != nil) != c.wantErr || len(got) != c.want {
				t.Fatalf("got %d findings, err %v", len(got), err)
			}
		})
	}
	got, _ := ParseFindings([]byte(scanJSON))
	f := got[0]
	// Lines are one-based in our finding type; ast-grep counts from zero.
	if f.RuleID != "no-console" || f.Severity != SeverityError || f.File != "src/a.ts" || f.Line != 4 || f.Message != "no console" {
		t.Fatalf("finding %+v", f)
	}
	if got[1].Note != "use let" || got[1].Severity != SeverityWarning {
		t.Fatalf("finding %+v", got[1])
	}
}

func TestScanExitCodes(t *testing.T) {
	cases := []struct {
		name     string
		r        fakeRunner
		want     int
		wantLoad bool
		wantErr  bool
	}{
		{"clean", fakeRunner{out: "[]"}, 0, false, false},
		{"error severity hits exit 1", fakeRunner{out: scanJSON, exit: 1}, 2, false, false},
		{"rule load failure is typed", fakeRunner{errOut: "Error: Cannot parse rule bad.yml", exit: 2}, 0, true, false},
		{"exit 1 with no json is a load failure", fakeRunner{errOut: "boom", exit: 1}, 0, true, false},
		{"exit 2 wins over parsable output", fakeRunner{out: scanJSON, errOut: "partial", exit: 2}, 0, true, false},
		{"runner failure is returned as is", fakeRunner{err: errors.New("spawn")}, 0, false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Scan(context.Background(), &c.r, "/repo", "sgconfig.yml")
			var le *RuleLoadError
			if errors.As(err, &le) != c.wantLoad {
				t.Fatalf("typed error = %v, want %v (err %v)", !c.wantLoad, c.wantLoad, err)
			}
			if c.wantLoad && le.Stderr != c.r.errOut {
				t.Fatalf("stderr not kept: %q", le.Stderr)
			}
			if (err != nil) != (c.wantLoad || c.wantErr) || len(got) != c.want {
				t.Fatalf("got %d, err %v", len(got), err)
			}
		})
	}
	r := &fakeRunner{out: "[]"}
	if _, err := Scan(context.Background(), r, "/repo", "sgconfig.yml"); err != nil {
		t.Fatal(err)
	}
	if r.gotDir != "/repo" || strings.Join(r.gotArgs, " ") != "scan --config sgconfig.yml --json=compact" {
		t.Fatalf("argv %q in %q", r.gotArgs, r.gotDir)
	}
}

func TestPinsRecordVersionAndSHA256(t *testing.T) {
	for _, plat := range []string{"linux/amd64", "linux/arm64", "darwin/amd64", "darwin/arm64"} {
		p, ok := Pins[plat]
		if !ok || p.Version != Version || len(p.SHA256) != 64 {
			t.Fatalf("%s: %+v", plat, p)
		}
		if _, err := hex.DecodeString(p.SHA256); err != nil {
			t.Fatalf("%s sha256: %v", plat, err)
		}
	}
}

func TestVerifyArchive(t *testing.T) {
	body := []byte("archive bytes")
	sum := sha256.Sum256(body)
	good := Pin{Version: Version, SHA256: hex.EncodeToString(sum[:])}
	if err := good.Verify(bytes.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	bad := Pin{Version: Version, SHA256: strings.Repeat("0", 64)}
	if err := bad.Verify(bytes.NewReader(body)); err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("want sha256 mismatch, got %v", err)
	}
}

func TestJailDeniesNetworkAndScopesWrites(t *testing.T) {
	spec := JailSpec("/work", "/opt/ast-grep/ast-grep")
	if spec.AllowNet {
		t.Fatal("ast-grep must run with no network")
	}
	if spec.Workdir != "/work" || len(spec.ReadOnly) != 1 || spec.ReadOnly[0] != "/opt/ast-grep" || len(spec.ReadWrite) != 0 {
		t.Fatalf("spec %+v", spec)
	}
	rep := sandbox.NewReport(spec, sandbox.Capabilities{Landlock: true, LandlockABI: 5, Rlimits: true})
	if !rep.Has("network: denied") {
		t.Fatalf("report %v", rep.Lines)
	}
}
