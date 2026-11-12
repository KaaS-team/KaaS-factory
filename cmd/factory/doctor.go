package main

import (
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

// checkStatus is the outcome of one doctor check.
type checkStatus string

const (
	statusPass checkStatus = "pass"
	statusWarn checkStatus = "warn"
	statusFail checkStatus = "fail"
)

// checkRow is one doctor result: what was checked, how it went and how to fix it.
type checkRow struct {
	Name   string
	Status checkStatus
	Detail string
	Fix    string
}

// runChecks runs every doctor check against the current PATH and environment.
func runChecks() []checkRow {
	rows := []checkRow{
		onPath("git", statusFail, "install git: https://git-scm.com/downloads"),
		ghCheck(),
		onPath("claude", statusFail, "install Claude Code and put `claude` on PATH"),
		onPath("go", statusWarn, "install Go 1.26 or newer to build from source"),
	}
	if _, err := loadConfig(nil); err != nil {
		rows = append(rows, checkRow{"config", statusFail, err.Error(), "fix .factory/factory.yaml or the FACTORY_* variables"})
	} else {
		rows = append(rows, checkRow{Name: "config", Status: statusPass, Detail: "loads"})
	}
	return append(rows, envCheck(os.Environ()))
}

func onPath(bin string, missing checkStatus, fix string) checkRow {
	p, err := exec.LookPath(bin)
	if err != nil {
		return checkRow{bin, missing, bin + " not found on PATH", fix}
	}
	return checkRow{Name: bin, Status: statusPass, Detail: p}
}

func ghCheck() checkRow {
	row := onPath("gh", statusFail, "install the GitHub CLI: https://cli.github.com")
	if row.Status != statusPass {
		return row
	}
	if err := exec.Command("gh", "auth", "status").Run(); err != nil {
		return checkRow{"gh", statusFail, "gh is not logged in", "run `gh auth login`"}
	}
	row.Detail += " (logged in)"
	return row
}

// envCheck fails when any ANTHROPIC_* variable is set: sessions run under the operator's login.
func envCheck(environ []string) checkRow {
	var set []string
	for _, kv := range environ {
		if k, _, _ := strings.Cut(kv, "="); strings.HasPrefix(k, "ANTHROPIC_") {
			set = append(set, k)
		}
	}
	if len(set) == 0 {
		return checkRow{Name: "env", Status: statusPass, Detail: "no ANTHROPIC_* variable set"}
	}
	sort.Strings(set)
	return checkRow{"env", statusFail, strings.Join(set, ", ") + " set", "unset " + strings.Join(set, " ") + "; sessions use your login"}
}

func doctorCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Check the tools and settings the factory needs",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			out := cmd.OutOrStdout()
			failed := 0
			for _, r := range runChecks() {
				_, _ = fmt.Fprintf(out, "%s\t%s\t%s\n", r.Status, r.Name, r.Detail)
				if r.Status != statusPass {
					_, _ = fmt.Fprintf(out, "\tfix: %s\n", r.Fix)
				}
				if r.Status == statusFail {
					failed++
				}
			}
			if failed > 0 {
				return fmt.Errorf("doctor: %d check(s) failed", failed)
			}
			return nil
		},
	}
}
