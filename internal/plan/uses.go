package plan

import (
	"fmt"
	"path"
	"strings"
)

// FilterUses keeps the paths that exist in the repo and drops the rest. Paths are cleaned, repo
// relative and unique; one that is absolute or climbs out of the repo is dropped. exists is given the
// cleaned path.
func FilterUses(uses []string, exists func(path string) bool) (kept, dropped []string) {
	seen := map[string]bool{}
	for _, u := range uses {
		p := path.Clean(strings.TrimSpace(u))
		if seen[p] {
			continue
		}
		seen[p] = true
		if p == "." || path.IsAbs(p) || p == ".." || strings.HasPrefix(p, "../") || !exists(p) {
			dropped = append(dropped, p)
			continue
		}
		kept = append(kept, p)
	}
	return kept, dropped
}

// UsesMetric is the log line for how many files a ticket offered against how many the session read.
func UsesMetric(id string, offered, read int) string {
	return fmt.Sprintf("uses_files ticket=%s offered=%d read=%d", id, offered, read)
}
