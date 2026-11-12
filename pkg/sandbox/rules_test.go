package sandbox

import (
	"reflect"
	"testing"
)

func TestLandlockRules(t *testing.T) {
	tests := []struct {
		name string
		spec Spec
		want []FSRule
	}{
		{"empty spec", Spec{}, nil},
		{"read only paths", Spec{ReadOnly: []string{"/usr", "/etc"}},
			[]FSRule{{"/usr", AccessRead}, {"/etc", AccessRead}}},
		{"read write and workdir", Spec{Workdir: "/w", ReadWrite: []string{"/tmp/x"}},
			[]FSRule{{"/tmp/x", AccessReadWrite}, {"/w", AccessReadWrite}}},
		{"empty and blank paths dropped", Spec{ReadOnly: []string{"", "  "}}, nil},
		{"paths are cleaned", Spec{ReadOnly: []string{"/usr/../usr/lib/"}},
			[]FSRule{{"/usr/lib", AccessRead}}},
		{"duplicate keeps the union at the first position", Spec{ReadOnly: []string{"/a", "/b"}, ReadWrite: []string{"/a"}},
			[]FSRule{{"/a", AccessReadWrite}, {"/b", AccessRead}}},
		{"workdir inside a read only path becomes writable on its own rule", Spec{Workdir: "/w", ReadOnly: []string{"/w"}},
			[]FSRule{{"/w", AccessReadWrite}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := LandlockRules(tt.spec); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v want %v", got, tt.want)
			}
		})
	}
}

func TestAccessBits(t *testing.T) {
	if AccessRead&AccessWriteFile != 0 {
		t.Fatal("read grants write")
	}
	for _, a := range []FSAccess{AccessExecute, AccessReadFile, AccessReadDir} {
		if AccessRead&a == 0 {
			t.Fatalf("read lacks bit %b", a)
		}
	}
	for _, a := range []FSAccess{AccessWriteFile, AccessRemoveDir, AccessRemoveFile, AccessMakeDir, AccessMakeReg, AccessMakeSym, AccessTruncate} {
		if AccessReadWrite&a == 0 {
			t.Fatalf("read-write lacks bit %b", a)
		}
	}
}

func TestDarwinProfile(t *testing.T) {
	const head = "(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (literal \"/dev/null\"))\n"
	tests := []struct {
		name string
		spec Spec
		want string
	}{
		{"nothing allowed", Spec{}, head + "(deny network*)\n"},
		{"workdir only, net allowed", Spec{Workdir: "/w", AllowNet: true},
			head + "(allow file-write* (subpath \"/w\"))\n"},
		{"read write and net denied", Spec{Workdir: "/w", ReadWrite: []string{"/tmp/a"}},
			head + "(allow file-write* (subpath \"/tmp/a\"))\n(allow file-write* (subpath \"/w\"))\n(deny network*)\n"},
		{"read only paths never get write", Spec{ReadOnly: []string{"/usr"}, AllowNet: true}, head},
		{"quotes are escaped", Spec{Workdir: `/a"b\c`, AllowNet: true},
			head + "(allow file-write* (subpath \"/a\\\"b\\\\c\"))\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DarwinProfile(tt.spec); got != tt.want {
				t.Fatalf("got\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
}
