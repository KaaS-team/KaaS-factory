package eval

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// maxCommandFuncLines is the readability cap for every function in command.go.
const maxCommandFuncLines = 60

// NewCommand was one 164-line closure; each function in command.go now stays short.
func TestCommandFunctionsStayShort(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "command.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range f.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok {
			continue
		}
		n := fset.Position(fn.End()).Line - fset.Position(fn.Pos()).Line + 1
		if n > maxCommandFuncLines {
			t.Errorf("command.go: %s is %d lines, cap %d; split it", fn.Name.Name, n, maxCommandFuncLines)
		}
	}
}
