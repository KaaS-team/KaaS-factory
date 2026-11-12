package packs

import (
	"fmt"
	"regexp"
	"strings"
)

var allowedLicences = map[string]bool{"MIT": true, "Apache-2.0": true}

// CheckLicence returns nil for MIT and Apache-2.0 and an error naming the licence for every other id.
func CheckLicence(id string) error {
	if allowedLicences[id] {
		return nil
	}
	if id == "" {
		return fmt.Errorf("licence refused: none declared (only MIT and Apache-2.0 are allowed)")
	}
	return fmt.Errorf("licence refused: %s (only MIT and Apache-2.0 are allowed)", id)
}

var spdxLine = regexp.MustCompile(`(?m)SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)`)

// DetectLicence guesses an SPDX id from licence text, and returns NOASSERTION when it cannot tell.
func DetectLicence(text []byte) string {
	if m := spdxLine.FindSubmatch(text); m != nil {
		return string(m[1])
	}
	s := strings.ToLower(string(text))
	switch {
	case strings.Contains(s, "gnu affero general public license"):
		return "AGPL-3.0"
	case strings.Contains(s, "gnu lesser general public license"):
		return "LGPL-3.0"
	case strings.Contains(s, "gnu general public license"):
		if strings.Contains(s, "version 2") {
			return "GPL-2.0"
		}
		return "GPL-3.0"
	case strings.Contains(s, "attribution-sharealike"):
		return "CC-BY-SA-4.0"
	case strings.Contains(s, "apache license") && strings.Contains(s, "version 2.0"):
		return "Apache-2.0"
	case strings.Contains(s, "permission is hereby granted, free of charge"):
		return "MIT"
	}
	return "NOASSERTION"
}
