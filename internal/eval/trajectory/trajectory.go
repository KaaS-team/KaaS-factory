// Package trajectory is the per-task record of an eval run (one JSON file per task) and the
// offline statistics over a set of them. The file shape follows the step list, final state and
// cost block of SWE-agent's trajectory files; no upstream code is used. Nothing here calls a
// model or the network.
package trajectory

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

// Schema is the version string written into every trajectory file.
const Schema = "factory.trajectory/v1"

// Final states of a task. Only StatePass counts as a success in the statistics.
const (
	StatePass    = "pass"
	StateFail    = "fail"
	StateAborted = "aborted"
)

// Step is one agent action and what came back. Diff, when set, is the whole working-tree diff
// after the step.
type Step struct {
	Action      string  `json:"action"`
	Observation string  `json:"observation,omitempty"`
	Seconds     float64 `json:"seconds,omitempty"`
	Diff        string  `json:"diff,omitempty"`
}

// Cost is the absolute usage of the whole task. CostUSD 0 means unknown.
type Cost struct {
	InputTokens  int64   `json:"input_tokens"`
	OutputTokens int64   `json:"output_tokens"`
	CostUSD      float64 `json:"cost_usd,omitempty"`
}

// Trajectory is the record of one task. Agent is a preset name, never a model name.
type Trajectory struct {
	Schema     string `json:"schema"`
	Task       string `json:"task"`
	Agent      string `json:"agent,omitempty"`
	Workflow   string `json:"workflow,omitempty"`
	Steps      []Step `json:"steps"`
	State      string `json:"state"`
	Submission string `json:"submission,omitempty"` // the final diff
	DiffSHA256 string `json:"diff_sha256,omitempty"`
	Cost       Cost   `json:"cost"`
}

var unsafeByte = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// FileName is the file a task is written to: each byte outside A-Za-z0-9._- becomes %XX, so the
// mapping is injective ("a/b" and "a-b" never share a file).
func FileName(task string) string {
	return unsafeByte.ReplaceAllStringFunc(task, func(b string) string { return fmt.Sprintf("%%%02X", b[0]) }) + ".json"
}

// Seal sets the schema and the final diff's checksum, so a later Replay can tell the file was cut or edited.
func (t *Trajectory) Seal() {
	t.Schema = Schema
	sum := sha256.Sum256([]byte(t.Submission))
	t.DiffSHA256 = hex.EncodeToString(sum[:])
}

// Write seals t and writes it to dir/FileName(t.Task), creating dir. It returns the path.
func Write(dir string, t Trajectory) (string, error) {
	if t.Task == "" {
		return "", errors.New("trajectory: task name is empty")
	}
	t.Seal()
	raw, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	p := filepath.Join(dir, FileName(t.Task))
	return p, os.WriteFile(p, append(raw, '\n'), 0o644)
}

// Read loads one trajectory file and checks its schema.
func Read(path string) (Trajectory, error) {
	var t Trajectory
	b, err := os.ReadFile(path)
	if err != nil {
		return t, err
	}
	if err := json.Unmarshal(b, &t); err != nil {
		return t, fmt.Errorf("%s: %w", path, err)
	}
	if t.Schema != Schema {
		return t, fmt.Errorf("%s: schema %q, want %q", path, t.Schema, Schema)
	}
	return t, nil
}

// Load reads path as one trajectory file, or as every *.json file in it when it is a directory.
// The result is sorted by task name; a task that appears twice, or whose Replay fails, is an error.
func Load(path string) ([]Trajectory, error) {
	files := []string{path}
	if fi, err := os.Stat(path); err != nil {
		return nil, err
	} else if fi.IsDir() {
		if files, err = filepath.Glob(filepath.Join(path, "*.json")); err != nil {
			return nil, err
		}
	}
	var out []Trajectory
	seen := map[string]string{}
	for _, f := range files {
		t, err := Read(f)
		if err != nil {
			return nil, err
		}
		if _, err := Replay(t); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		if prev, dup := seen[t.Task]; dup {
			return nil, fmt.Errorf("task %q is in both %s and %s", t.Task, prev, f)
		}
		seen[t.Task] = f
		out = append(out, t)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: no trajectory files", path)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Task < out[j].Task })
	return out, nil
}

// Replay returns the final diff of a recorded run from its steps alone: the diff of the last step
// that has one. It fails when that diff does not match the recorded checksum of the submission, so
// a cut or edited file is not replayed as if it were whole.
func Replay(t Trajectory) (string, error) {
	var diff string
	for _, s := range t.Steps {
		if s.Diff != "" {
			diff = s.Diff
		}
	}
	sum := sha256.Sum256([]byte(diff))
	if hex.EncodeToString(sum[:]) != t.DiffSHA256 {
		return "", fmt.Errorf("trajectory %s: last step diff does not match the recorded checksum", t.Task)
	}
	return diff, nil
}
