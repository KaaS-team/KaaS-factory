// Command prcheck runs the pull-request checks CI enforces: dco, body and tests-only.
package main

import (
	"fmt"
	"io"
	"os"
)

const usage = "usage: prcheck dco <base> [head] | body | tests-only <base> <head>"

// run dispatches one subcommand in the repo at dir and returns the exit code.
func run(dir string, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	switch args[0] {
	case "dco":
		return runDCO(dir, args[1:], stdout, stderr)
	}
	fmt.Fprintf(stderr, "prcheck: unknown subcommand %q\n%s\n", args[0], usage)
	return 2
}

func main() {
	os.Exit(run(".", os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}
