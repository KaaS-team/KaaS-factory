// Ported from sourcegraph/zoekt@9e78667 index/file_category.go
package packs

import "github.com/go-enry/go-enry/v2"

// FileCategory is the kind of a file as go-enry sees it: test, vendored, generated and so on.
type FileCategory byte

// The categories, in the order DetermineFileCategory tries them after Binary.
const (
	FileCategoryDefault FileCategory = iota + 1
	FileCategoryTest
	FileCategoryVendored
	FileCategoryGenerated
	FileCategoryConfig
	FileCategoryDotFile
	FileCategoryBinary
	FileCategoryDocumentation
)

// SkipReason says why a file's content was not read.
type SkipReason byte

// The reasons a file's content may be absent.
const (
	SkipNone SkipReason = iota
	SkipTooLarge
	SkipBinary
)

// File is the name, content and skip reason of one candidate file for a pack.
type File struct {
	Name    string
	Content []byte
	Skip    SkipReason
}

// DetermineFileCategory classifies f by name, and by content unless the content was skipped.
func DetermineFileCategory(f File) FileCategory {
	content := f.Content
	if f.Skip != SkipNone {
		content = nil
	}
	switch {
	case f.Skip == SkipBinary:
		return FileCategoryBinary
	case enry.IsTest(f.Name):
		return FileCategoryTest
	case enry.IsDotFile(f.Name):
		return FileCategoryDotFile
	case enry.IsVendor(f.Name):
		return FileCategoryVendored
	case enry.IsGenerated(f.Name, content):
		return FileCategoryGenerated
	case enry.IsConfiguration(f.Name):
		return FileCategoryConfig
	case enry.IsDocumentation(f.Name):
		return FileCategoryDocumentation
	}
	return FileCategoryDefault
}

// LowPriority reports whether a pack should demote files of this category.
func (c FileCategory) LowPriority() bool {
	return c == FileCategoryTest || c == FileCategoryVendored || c == FileCategoryGenerated || c == FileCategoryBinary
}
