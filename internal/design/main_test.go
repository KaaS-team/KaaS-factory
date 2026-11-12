package design

import (
	"os"
	"testing"

	"github.com/KaaS-team/factory/pkg/sandbox"
)

// TestMain lets this test binary act as the jail helper the sandbox re-executes.
func TestMain(m *testing.M) {
	if err := sandbox.MaybeEnter(); err != nil {
		_, _ = os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(97)
	}
	os.Exit(m.Run())
}
