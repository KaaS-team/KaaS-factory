// Package design runs the deterministic design-edit step: it hands a design delta to the pinned
// node pack in packs/design and reports whether the edit was made without a coding agent.
package design

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"

	"github.com/KaaS-team/factory/pkg/sandbox"
)

// Runner runs one command of the pack's node CLI in dir and returns its stdout and exit code.
type Runner interface {
	Run(ctx context.Context, dir string, stdin []byte, args ...string) (stdout []byte, exit int, err error)
}

// NodeRunner runs packs/design/bin/design.js with node. With Jail set the process runs under
// pkg/sandbox with the network denied and only dir writable.
type NodeRunner struct {
	Pack string
	Jail bool
}

// Run runs the CLI. A non-zero exit is returned as the exit code, not as an error.
func (n NodeRunner) Run(ctx context.Context, dir string, stdin []byte, args ...string) ([]byte, int, error) {
	argv := append([]string{n.Pack + "/bin/design.js"}, args...)
	var cmd *exec.Cmd
	if n.Jail {
		var err error
		spec := sandbox.Spec{Workdir: dir, ReadOnly: []string{"/"}, ReadWrite: []string{dir}, Env: []string{"PATH=" + os.Getenv("PATH")}}
		if cmd, err = sandbox.Command(ctx, spec, "node", argv...); err != nil {
			return nil, 0, err
		}
	} else {
		cmd = exec.CommandContext(ctx, "node", argv...)
		cmd.Dir = dir
	}
	cmd.Stdin = bytes.NewReader(stdin)
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.Bytes(), ee.ExitCode(), nil
	}
	return out.Bytes(), 0, err
}

// Fallback says why an edit cannot be made deterministically; the step then needs an agent.
type Fallback struct {
	// Code is the pack's reason, such as "dynamic", "missing-oid" or "unsupported-kind".
	Code string `json:"error"`
	// OID is the element the reason is about, when there is one.
	OID     string `json:"oid"`
	Message string `json:"message"`
}

// Error describes the fallback.
func (f *Fallback) Error() string { return "design: needs an agent: " + f.Code + ": " + f.Message }

// Diff is the original and edited text of one file.
type Diff struct {
	Original  string `json:"original"`
	Generated string `json:"generated"`
	Path      string `json:"path"`
}

// Request is the pack's CodeDiffRequest: edits for the element carrying OID.
type Request struct {
	OID             string           `json:"oid"`
	BranchID        string           `json:"branchId"`
	Attributes      map[string]any   `json:"attributes"`
	TextContent     *string          `json:"textContent"`
	OverrideClasses *bool            `json:"overrideClasses"`
	StructureChange []map[string]any `json:"structureChanges"`
}

// call runs one pack command and decodes its stdout into v. Exit 2 comes back as *Fallback.
func call(ctx context.Context, r Runner, dir string, stdin []byte, v any, args ...string) error {
	out, code, err := r.Run(ctx, dir, stdin, args...)
	if err != nil {
		return fmt.Errorf("design: %w", err)
	}
	switch code {
	case 0:
		return json.Unmarshal(out, v)
	case 2:
		f := &Fallback{}
		if err := json.Unmarshal(out, f); err != nil {
			return fmt.Errorf("design: bad fallback output: %w", err)
		}
		return f
	}
	return fmt.Errorf("design: %s exited %d: %s", args[0], code, bytes.TrimSpace(out))
}

// ApplyEdits applies requests to file (relative to dir) and returns the diff without writing it.
// With stripIDs no data-oid or move key is left in the result.
func ApplyEdits(ctx context.Context, r Runner, dir, file string, requests []Request, stripIDs bool) (Diff, error) {
	in, err := json.Marshal(struct {
		File     string    `json:"file"`
		Requests []Request `json:"requests"`
	}{file, requests})
	if err != nil {
		return Diff{}, err
	}
	args := []string{"apply-edits"}
	if stripIDs {
		args = append(args, "--strip-ids")
	}
	var d Diff
	return d, call(ctx, r, dir, in, &d, args...)
}

// Stamp gives every JSX element under dir one oid, unique across the tree, and returns the files it changed.
func Stamp(ctx context.Context, r Runner, dir string) ([]string, error) {
	var out struct {
		Stamped []string `json:"stamped"`
	}
	return out.Stamped, call(ctx, r, dir, nil, &out, "oid-stamp", dir)
}

// Outcome is what Step did.
type Outcome struct {
	// Deterministic is true when the delta was applied with no agent session.
	Deterministic bool
	// Files are the files rewritten on the deterministic path.
	Files []string
	// Reason is the fallback code when Deterministic is false.
	Reason string
}

// Step applies the design delta at deltaPath (relative to dir): style, text, move and remove
// changes on static elements are written to the tree and no agent runs. Anything else calls
// agent once, so the caller opens the PR either way.
func Step(ctx context.Context, r Runner, dir, deltaPath string, agent func(context.Context) error) (Outcome, error) {
	var out struct {
		Applied []string `json:"applied"`
	}
	err := call(ctx, r, dir, nil, &out, "tweak", dir, deltaPath)
	var fb *Fallback
	switch {
	case err == nil:
		return Outcome{Deterministic: true, Files: out.Applied}, nil
	case errors.As(err, &fb):
		return Outcome{Reason: fb.Code}, agent(ctx)
	}
	return Outcome{}, err
}
