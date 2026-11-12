package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"strings"
)

// Executor does the work of a step: a command or a model prompt, both inside dir.
type Executor interface {
	Exec(ctx context.Context, dir string, argv []string) error
	Prompt(ctx context.Context, dir, prompt string, files []string) error
}

// Recorder receives how many files a step's preconditions kept it from seeing.
type Recorder interface {
	Skipped(step string, files int)
}

// Options configures Run. Meter and Log may be nil.
type Options struct {
	Root  string
	Exec  Executor
	Meter Recorder
	Log   io.Writer
}

// StepResult is what happened to one runnable step.
type StepResult struct {
	Path    string
	Matched int
	Skipped int
	Ran     bool
}

// Run executes the pack's steps in order over the files under Root. A step whose preconditions
// match no file is skipped without calling the Executor, so it spends nothing. The first failing
// step stops the run.
func Run(ctx context.Context, p *Pack, o Options) ([]StepResult, error) {
	fsys := os.DirFS(o.Root)
	files, err := listFiles(fsys)
	if err != nil {
		return nil, err
	}
	var out []StepResult
	for _, l := range p.Flatten() {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		var seen []string
		for _, f := range files {
			ok, err := MatchAll(l.Files, fsys, f)
			if err != nil {
				return out, fmt.Errorf("step %s: %w", l.Path, err)
			}
			if ok {
				seen = append(seen, f)
			}
		}
		r := StepResult{Path: l.Path, Matched: len(seen), Skipped: len(files) - len(seen)}
		if o.Meter != nil {
			o.Meter.Skipped(l.Path, r.Skipped)
		}
		if len(seen) == 0 {
			logf(o.Log, "step %s: skipped: precondition (%d files skipped)\n", l.Path, r.Skipped)
			out = append(out, r)
			continue
		}
		if l.Step.Prompt != "" {
			err = o.Exec.Prompt(ctx, o.Root, l.Step.Prompt, seen)
		} else {
			err = o.Exec.Exec(ctx, o.Root, expand(l.Step.Run, seen))
		}
		if err != nil {
			return out, fmt.Errorf("step %s: %w", l.Path, err)
		}
		r.Ran = true
		logf(o.Log, "step %s: ran on %d files\n", l.Path, len(seen))
		out = append(out, r)
	}
	return out, nil
}

func logf(w io.Writer, format string, a ...any) {
	if w != nil {
		_, _ = fmt.Fprintf(w, format, a...)
	}
}

func expand(argv, files []string) []string {
	var out []string
	for _, a := range argv {
		if a == "{files}" {
			for _, f := range files {
				out = append(out, safeArg(f))
			}
		} else {
			out = append(out, a)
		}
	}
	return out
}

// safeArg keeps a file name that starts with "-" from being read as a flag. A "./" prefix works for
// every command, where "--" is not accepted by all of them.
func safeArg(f string) string {
	if strings.HasPrefix(f, "-") {
		return "./" + f
	}
	return f
}

func listFiles(fsys fs.FS) ([]string, error) {
	var files []string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" || d.Name() == "node_modules" {
				return fs.SkipDir
			}
			return nil
		}
		files = append(files, p)
		return nil
	})
	return files, err
}

// Verify checks pack bytes against the sha256 pinned for them in factory.lock.
func Verify(pinnedSHA256 string, data []byte) error {
	if got := sha256Sum(data); got != pinnedSHA256 {
		return fmt.Errorf("pack does not match factory.lock: lock has %s, file has %s", pinnedSHA256, got)
	}
	return nil
}

// ErrNoAgent is what the default runner returns for a prompt step: nothing here can run a prompt.
var ErrNoAgent = errors.New("no agent configured for prompt steps")

// ExecRunner runs commands as child processes with no shell. It has no agent, so a prompt step fails
// with ErrNoAgent rather than reporting work that did not happen; the prompt and files go to Out so
// the operator can run them by hand.
type ExecRunner struct{ Out io.Writer }

// Exec runs argv in dir.
func (e ExecRunner) Exec(ctx context.Context, dir string, argv []string) error {
	c := exec.CommandContext(ctx, argv[0], argv[1:]...)
	c.Dir, c.Stdout, c.Stderr = dir, e.Out, e.Out
	return c.Run()
}

// Prompt writes the prompt and the files it applies to, then returns ErrNoAgent.
func (e ExecRunner) Prompt(_ context.Context, _, prompt string, files []string) error {
	if e.Out != nil {
		_, _ = fmt.Fprintf(e.Out, "prompt: %s\nfiles: %s\n", prompt, strings.Join(files, " "))
	}
	return ErrNoAgent
}

func sha256Sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
