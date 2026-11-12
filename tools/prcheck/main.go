// Command prcheck runs the pull-request checks CI enforces: dco, body and tests-only.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

const usage = "usage: prcheck dco <base> [head] | body | tests-only <base> <head>"

// run dispatches one subcommand in the repo at dir and returns the exit code.
func run(dir string, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		sayln(stderr, usage)
		return 2
	}
	switch args[0] {
	case "dco":
		return runDCO(dir, args[1:], stdout, stderr)
	case "body":
		return runBody(dir, args[1:], getenv, stdout, stderr)
	case "tests-only":
		return runTestsOnly(dir, args[1:], getenv, stdout, stderr)
	}
	sayf(stderr, "prcheck: unknown subcommand %q\n%s\n", args[0], usage)
	return 2
}

func main() {
	os.Exit(run(".", os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

func sayln(w io.Writer, a ...any) { _, _ = fmt.Fprintln(w, a...) }

func sayf(w io.Writer, format string, a ...any) { _, _ = fmt.Fprintf(w, format, a...) }

// gitOut runs git in dir and returns its stdout; the error carries git's own stderr.
func gitOut(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return nil, errors.New(strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, err
	}
	return out, nil
}
