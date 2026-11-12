package sandbox

import (
	"path/filepath"
	"strings"
)

// FSAccess is a set of filesystem rights, named after the Landlock rights.
type FSAccess uint32

// Filesystem rights a rule can grant.
const (
	AccessExecute FSAccess = 1 << iota
	AccessReadFile
	AccessReadDir
	AccessWriteFile
	AccessRemoveDir
	AccessRemoveFile
	AccessMakeDir
	AccessMakeReg
	AccessMakeSym
	AccessTruncate
)

// AccessRead is what a ReadOnly path gets.
const AccessRead = AccessExecute | AccessReadFile | AccessReadDir

// AccessReadWrite is what a ReadWrite path and the workdir get.
const AccessReadWrite = AccessRead | AccessWriteFile | AccessRemoveDir | AccessRemoveFile |
	AccessMakeDir | AccessMakeReg | AccessMakeSym | AccessTruncate

// FSRule grants Access under Path.
type FSRule struct {
	Path   string
	Access FSAccess
}

// LandlockRules is the pure rule set for spec: ReadOnly paths, then ReadWrite
// paths, then the workdir. Empty paths are dropped, paths are cleaned, and a
// path listed twice keeps the union of its rights at its first position.
func LandlockRules(spec Spec) []FSRule {
	var out []FSRule
	add := func(p string, a FSAccess) {
		if strings.TrimSpace(p) == "" {
			return
		}
		p = filepath.Clean(p)
		for i := range out {
			if out[i].Path == p {
				out[i].Access |= a
				return
			}
		}
		out = append(out, FSRule{Path: p, Access: a})
	}
	for _, p := range spec.ReadOnly {
		add(p, AccessRead)
	}
	for _, p := range spec.ReadWrite {
		add(p, AccessReadWrite)
	}
	add(spec.Workdir, AccessReadWrite)
	return out
}

// DarwinProfile is the pure sandbox-exec profile for spec. It denies writes
// outside ReadWrite and Workdir, and network access when AllowNet is false.
func DarwinProfile(spec Spec) string {
	var b strings.Builder
	b.WriteString("(version 1)\n(allow default)\n(deny file-write*)\n")
	b.WriteString("(allow file-write* (literal \"/dev/null\"))\n")
	for _, r := range LandlockRules(spec) {
		if r.Access&AccessWriteFile != 0 {
			b.WriteString("(allow file-write* (subpath " + sbplQuote(r.Path) + "))\n")
		}
	}
	if !spec.AllowNet {
		b.WriteString("(deny network*)\n")
	}
	return b.String()
}

func sbplQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}
