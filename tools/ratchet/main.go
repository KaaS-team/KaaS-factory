// Command ratchet fails when non-test Go lines or deadcode entries exceed .ratchet.json.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	baselineFile = ".ratchet.json"
	// deadcodeRef is the pinned deadcode version; deadcodeGo is the toolchain it needs.
	deadcodeRef = "golang.org/x/tools/cmd/deadcode@v0.39.0"
	deadcodeGo  = "go1.26.7"
	// deadcodeOS and deadcodeArch are the platform deadcode analyses: the one CI runs on.
	deadcodeOS   = "linux"
	deadcodeArch = "amd64"
)

// Counts holds the two measured numbers.
type Counts struct {
	GoLines  int `json:"go_lines"`
	Deadcode int `json:"deadcode"`
}

// Baseline is the stored ceiling plus the reason line a hand edit must update.
type Baseline struct {
	GoLines  int    `json:"go_lines"`
	Deadcode int    `json:"deadcode"`
	Reason   string `json:"reason"`
}

// Check returns an error naming every count that is above the baseline.
func Check(b Baseline, c Counts) error {
	var errs []error
	if c.GoLines > b.GoLines {
		errs = append(errs, fmt.Errorf("go_lines %d is above baseline %d", c.GoLines, b.GoLines))
	}
	if c.Deadcode > b.Deadcode {
		errs = append(errs, fmt.Errorf("deadcode %d is above baseline %d", c.Deadcode, b.Deadcode))
	}
	return errors.Join(errs...)
}

// Lower returns the baseline with each count set to the smaller of stored and measured; it never raises.
func Lower(b Baseline, c Counts) Baseline {
	b.GoLines = min(b.GoLines, c.GoLines)
	b.Deadcode = min(b.Deadcode, c.Deadcode)
	return b
}

// CountGoLines sums the lines of the non-test .go files in names, skipping the frozen src/ tree.
func CountGoLines(root string, names []string) (int, error) {
	total := 0
	for _, n := range names {
		if !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") || strings.HasPrefix(n, "src/") {
			continue
		}
		data, err := os.ReadFile(root + "/" + n)
		if err != nil {
			return 0, err
		}
		total += bytes.Count(data, []byte("\n"))
		if len(data) > 0 && data[len(data)-1] != '\n' {
			total++
		}
	}
	return total, nil
}

// CountDeadcode counts the non-empty lines of deadcode output.
func CountDeadcode(out string) int {
	n := 0
	for _, l := range strings.Split(out, "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return n
}

// Run measures, compares with the baseline file, and with update lowers the file when the check passes.
func Run(path string, update bool, measure func() (Counts, error), out io.Writer) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var b Baseline
	if err := json.Unmarshal(data, &b); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	c, err := measure()
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "go_lines %d (baseline %d), deadcode %d (baseline %d)\n", c.GoLines, b.GoLines, c.Deadcode, b.Deadcode)
	if err := Check(b, c); err != nil {
		return err
	}
	if !update {
		return nil
	}
	next := Lower(b, c)
	if next == b {
		return nil
	}
	enc, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(enc, '\n'), 0o644)
}

func measureRepo() (Counts, error) {
	ls, err := exec.Command("git", "ls-files", "*.go").Output()
	if err != nil {
		return Counts{}, fmt.Errorf("git ls-files: %w", err)
	}
	lines, err := CountGoLines(".", strings.Fields(string(ls)))
	if err != nil {
		return Counts{}, err
	}
	// Build deadcode for the host, then analyse as linux/amd64 (the CI platform), so a laptop and
	// CI count the same files: darwin-only funcs are unreachable on linux and vice versa.
	bin, err := os.MkdirTemp("", "ratchet")
	if err != nil {
		return Counts{}, err
	}
	defer func() { _ = os.RemoveAll(bin) }()
	install := exec.Command("go", "install", deadcodeRef)
	install.Env = append(os.Environ(), "GOTOOLCHAIN="+deadcodeGo, "GOBIN="+bin)
	if out, err := install.CombinedOutput(); err != nil {
		return Counts{}, fmt.Errorf("install deadcode: %w\n%s", err, out)
	}
	cmd := exec.Command(filepath.Join(bin, "deadcode"), "./...")
	cmd.Env = append(os.Environ(), "GOTOOLCHAIN="+deadcodeGo, "GOOS="+deadcodeOS, "GOARCH="+deadcodeArch)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	dead, err := cmd.Output()
	if err != nil {
		return Counts{}, fmt.Errorf("deadcode: %w\n%s", err, stderr.String())
	}
	return Counts{GoLines: lines, Deadcode: CountDeadcode(string(dead))}, nil
}

func main() {
	update := len(os.Args) > 1 && os.Args[1] == "--update"
	if err := Run(baselineFile, update, measureRepo, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "ratchet:", err)
		os.Exit(1)
	}
}
