package broker

import (
	"errors"
	"testing"
)

// TestClassifyRejectsDotSegments: a path with "..", "." or an empty segment is unclassified, so the
// gate cannot approve one repository while upstream resolves the request to another.
func TestClassifyRejectsDotSegments(t *testing.T) {
	c := &githubConn{}
	for _, tc := range []struct{ method, target string }{
		{"GET", "/repos/o/r/../../other/secret"},
		{"GET", "/repos/o/r/%2e%2e/%2e%2e/user"},
		{"PATCH", "/repos/o/r/pulls/.."},
		{"POST", "/repos/o/r/pulls/../../../x/y/pulls"},
		{"GET", "/repos/o//r"},
		{"GET", "/repos/../x"},
	} {
		if _, err := c.Classify(tc.method, tc.target); !errors.Is(err, ErrUnclassified) {
			t.Errorf("%s %s: err = %v, want ErrUnclassified", tc.method, tc.target, err)
		}
	}
}
