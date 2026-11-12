package packs

import (
	"strings"
	"testing"
)

func TestCheckLicence(t *testing.T) {
	cases := []struct {
		id      string
		refused bool
	}{
		{"MIT", false}, {"Apache-2.0", false},
		{"AGPL-3.0", true}, {"AGPL-3.0-only", true}, {"GPL-3.0", true}, {"GPL-2.0-or-later", true},
		{"LGPL-3.0", true}, {"CC-BY-SA-4.0", true}, {"NOASSERTION", true}, {"", true}, {"Proprietary-X", true},
		{"mit", true},
	}
	for _, c := range cases {
		err := CheckLicence(c.id)
		if c.refused != (err != nil) {
			t.Errorf("%q: refused=%v err=%v", c.id, c.refused, err)
		}
		if err != nil && c.id != "" && !strings.Contains(err.Error(), c.id) {
			t.Errorf("%q: error %q does not name the licence", c.id, err)
		}
	}
}

func TestDetectLicence(t *testing.T) {
	cases := map[string]string{
		"MIT License\n\nPermission is hereby granted, free of charge, to any person": "MIT",
		"Apache License\nVersion 2.0, January 2004":                                  "Apache-2.0",
		"GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007":             "AGPL-3.0",
		"GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007":                        "GPL-3.0",
		"Attribution-ShareAlike 4.0 International":                                   "CC-BY-SA-4.0",
		"SPDX-License-Identifier: Apache-2.0\nanything":                              "Apache-2.0",
		"all rights reserved": "NOASSERTION",
		"":                    "NOASSERTION",
	}
	for text, want := range cases {
		if got := DetectLicence([]byte(text)); got != want {
			t.Errorf("%q: got %q want %q", text, got, want)
		}
	}
}
