package browsercheck

import (
	"strings"
	"testing"
)

func TestParseSteps(t *testing.T) {
	tests := []struct {
		name    string
		yaml    string
		wantErr string
		kinds   []string
	}{
		{"all kinds", `
- goto: http://127.0.0.1:3000/
- click: "#go"
- fill: {selector: "#name", value: ada}
- expect_text: hello
- expect_no_console_error: true
- screenshot: home
`, "", []string{"goto", "click", "fill", "expect_text", "expect_no_console_error", "screenshot"}},
		{"unknown step", "- hover: \"#x\"\n", "step 1: unknown step \"hover\"", nil},
		{"two keys", "- {goto: http://a.test/, click: \"#x\"}\n", "step 1: want exactly one key", nil},
		{"click missing selector", "- click: \"\"\n", "step 1: click needs a selector", nil},
		{"fill missing selector", "- fill: {value: x}\n", "step 1: fill needs a selector", nil},
		{"fill missing value key", "- fill: {selector: \"#a\"}\n", "step 1: fill needs a value", nil},
		{"expect_text empty", "- expect_text: \"\"\n", "step 1: expect_text needs text", nil},
		{"bad url", "- goto: \"not a url\"\n", "step 1: goto needs an http or https URL", nil},
		{"file url", "- goto: file:///etc/passwd\n", "step 1: goto needs an http or https URL", nil},
		{"screenshot bad name", "- screenshot: ../x\n", "step 1: screenshot name must be a plain file name", nil},
		{"not a list", "goto: http://a.test/\n", "steps must be a YAML list", nil},
		{"empty list", "[]\n", "no steps", nil},
		{"error index", "- goto: http://a.test/\n- click: \"\"\n", "step 2:", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			steps, err := ParseSteps([]byte(tt.yaml))
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(steps) != len(tt.kinds) {
				t.Fatalf("got %d steps", len(steps))
			}
			for i, k := range tt.kinds {
				if steps[i].Kind != k {
					t.Errorf("step %d kind = %q, want %q", i, steps[i].Kind, k)
				}
			}
		})
	}
}
