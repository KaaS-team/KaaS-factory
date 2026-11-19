package redact_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/gate"
	"github.com/KaaS-team/factory/internal/logs"
	"github.com/KaaS-team/factory/internal/redact"
	"github.com/KaaS-team/factory/internal/tracker/sanitize"
)

// One walk over every caller: each token kind must be gone from the gate tail, the prompt
// sanitizer and the log printer. A caller that keeps its own list fails here.
func TestEveryCallerRedactsEveryKind(t *testing.T) {
	callers := map[string]func(tok string) string{
		"gate tail": func(tok string) string {
			return gate.Run(context.Background(), gate.Spec{Command: "echo 'using " + tok + " now'", Timeout: 5 * time.Second}).Tail
		},
		"sanitize.Prompt": func(tok string) string { return sanitize.Prompt("using " + tok + " now") },
		"logs.Redact":     func(tok string) string { return logs.Redact("using " + tok + " now") },
	}
	for kind, tok := range redact.Samples() {
		for caller, run := range callers {
			t.Run(caller+"/"+kind, func(t *testing.T) {
				got := run(tok)
				if strings.Contains(got, tok) {
					t.Fatalf("%s leaked %s: %q", caller, kind, got)
				}
				if got == "" || !strings.Contains(got, "redacted") && !strings.Contains(got, "REDACTED") {
					t.Fatalf("%s left no redaction mark for %s: %q", caller, kind, got)
				}
			})
		}
	}
}
