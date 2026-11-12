// Ported from ast-grep/ast-grep@c7e005c crates/cli/src/print/json_print.rs (output schema only)

// Package astgrep runs the pinned ast-grep release binary in the jail and reads what it prints.
// No Rust is ported: the binary does the parsing, this package does the argv, the jail spec, the
// checksum pin and the decoding of `scan --json`.
package astgrep

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/KaaS-team/factory/pkg/sandbox"
)

// Version is the pinned ast-grep release.
const Version = "0.51.2"

// Pin is the release archive a platform must match: the version and the sha256 of its zip.
type Pin struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

// Pins maps GOOS/GOARCH to the release archive of Version, from
// https://github.com/ast-grep/ast-grep/releases/download/0.51.2/app-<triple>.zip.
var Pins = map[string]Pin{
	"linux/amd64":  {Version, "40604c21c38d4c7581c56bdddeef277c56bf3c0113620aa96e78ae87e82366df"},
	"linux/arm64":  {Version, "c3ab2bd43959db28621dc1551c13ea5fe5db4c1fc7b18086dade6b65042c78d0"},
	"darwin/amd64": {Version, "ef347c331d97cb6a043809091bd96bdd64de6a8354f01da66764496885230591"},
	"darwin/arm64": {Version, "ea4f4082d25e5f8e0450add6fd488dd008a373c90483cc2031759c8431f1dcfb"},
}

// Verify reads the archive and returns an error unless its sha256 equals the pin.
func (p Pin) Verify(archive io.Reader) error {
	h := sha256.New()
	if _, err := io.Copy(h, archive); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != p.SHA256 {
		return fmt.Errorf("ast-grep %s: sha256 %s does not match the pin %s", p.Version, got, p.SHA256)
	}
	return nil
}

// Result is what one ast-grep process produced.
type Result struct {
	Stdout, Stderr []byte
	Exit           int
}

// Runner runs ast-grep with args in dir. A non-zero exit is a Result, not an error.
type Runner interface {
	Run(ctx context.Context, dir string, args []string) (Result, error)
}

// JailSpec is the jail for one run: the binary's directory is read only, dir is the only writable
// path, and the network is denied.
func JailSpec(dir, bin string) sandbox.Spec {
	return sandbox.Spec{Workdir: dir, ReadOnly: []string{filepath.Dir(bin)}, AllowNet: false, Env: []string{"NO_COLOR=1"}}
}

// RuleLoadError means ast-grep could not load a rule or a config, so nothing was scanned.
type RuleLoadError struct{ Stderr string }

func (e *RuleLoadError) Error() string {
	return "ast-grep could not load the rules: " + strings.TrimSpace(e.Stderr)
}

// Severity is a rule's severity as ast-grep names it.
type Severity string

// The severities ast-grep knows. A rule with none set is a hint.
const (
	SeverityOff     Severity = "off"
	SeverityHint    Severity = "hint"
	SeverityInfo    Severity = "info"
	SeverityWarning Severity = "warning"
	SeverityError   Severity = "error"
)

// Finding is one match of one rule. Line is one-based.
type Finding struct {
	RuleID   string
	Severity Severity
	Message  string
	Note     string
	File     string
	Line     int
	Text     string
}

type matchJSON struct {
	Text  string `json:"text"`
	File  string `json:"file"`
	Range struct {
		Start struct {
			Line int `json:"line"`
		} `json:"start"`
	} `json:"range"`
	RuleID   string   `json:"ruleId"`
	Severity Severity `json:"severity"`
	Note     *string  `json:"note"`
	Message  string   `json:"message"`
}

// ParseFindings decodes the array `ast-grep scan --json` prints. Blank output is no findings.
func ParseFindings(b []byte) ([]Finding, error) {
	if len(bytes.TrimSpace(b)) == 0 {
		return nil, nil
	}
	var ms []matchJSON
	if err := json.Unmarshal(b, &ms); err != nil {
		return nil, fmt.Errorf("ast-grep scan output: %w", err)
	}
	out := make([]Finding, 0, len(ms))
	for _, m := range ms {
		f := Finding{RuleID: m.RuleID, Severity: m.Severity, Message: m.Message, File: m.File, Line: m.Range.Start.Line + 1, Text: m.Text}
		if m.Note != nil {
			f.Note = *m.Note
		}
		out = append(out, f)
	}
	return out, nil
}

// Scan runs `scan --config config --json=compact` in dir. Exit 1 means error-severity findings
// and is not a failure; any other non-zero exit, or exit 1 with nothing to read, is a *RuleLoadError.
func Scan(ctx context.Context, r Runner, dir, config string) ([]Finding, error) {
	res, err := r.Run(ctx, dir, []string{"scan", "--config", config, "--json=compact"})
	if err != nil {
		return nil, err
	}
	fs, perr := ParseFindings(res.Stdout)
	if res.Exit > 1 || (res.Exit != 0 && len(fs) == 0) || perr != nil && res.Exit != 0 {
		return nil, &RuleLoadError{Stderr: string(res.Stderr)}
	}
	if perr != nil {
		return nil, perr
	}
	return fs, nil
}

// Policy is what a finding does to the gate.
type Policy string

// The gate policies, from strictest to none.
const (
	PolicyBlock  Policy = "block"
	PolicyWarn   Policy = "warn"
	PolicyNote   Policy = "note"
	PolicyIgnore Policy = "ignore"
)

// Policy maps a severity to the gate: error blocks, warning warns, hint and info note, off is dropped.
func (s Severity) Policy() Policy {
	switch s {
	case SeverityError:
		return PolicyBlock
	case SeverityWarning:
		return PolicyWarn
	case SeverityOff:
		return PolicyIgnore
	}
	return PolicyNote
}

// Verdict is the gate's reading of a scan.
type Verdict struct {
	Block      bool
	Warn, Note int
}

// Gate counts findings by policy; any error-severity finding blocks.
func Gate(fs []Finding) Verdict {
	var v Verdict
	for _, f := range fs {
		switch f.Severity.Policy() {
		case PolicyBlock:
			v.Block = true
		case PolicyWarn:
			v.Warn++
		case PolicyNote:
			v.Note++
		}
	}
	return v
}
