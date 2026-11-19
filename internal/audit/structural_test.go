package audit_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

// writeMethods are the exported *Tracker methods that change the world. Each must record.
var writeMethods = map[string]bool{
	"Comment": true, "SetPhase": true, "Create": true, "PutSpendComment": true,
	"RecordStatus": true, "SavePosition": true, "OpenPR": true,
}

// readOnly are the api.Tracker and api.Thread methods that change nothing.
var readOnly = map[string]bool{"Name": true, "Ready": true, "Get": true, "SpendComment": true}

// mutating verbs on the go-github client; a method that calls one directly is a write.
var mutating = []string{"Create", "Edit", "Delete", "Add", "Remove", "Merge", "Update", "Set"}

func TestEveryPortWriteIsKnown(t *testing.T) {
	for _, typ := range []reflect.Type{reflect.TypeFor[api.Tracker](), reflect.TypeFor[api.Thread]()} {
		for i := range typ.NumMethod() {
			n := typ.Method(i).Name
			if !readOnly[n] && !writeMethods[n] {
				t.Errorf("%s.%s is neither read-only nor a listed write: classify it", typ.Name(), n)
			}
		}
	}
}

func TestEveryTrackerWriteRecords(t *testing.T) {
	for _, dir := range []string{"../tracker/github", "../tracker/jira", "../tracker/linear"} {
		fset := token.NewFileSet()
		ents, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		var files []*ast.File
		for _, e := range ents {
			if !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			f, err := parser.ParseFile(fset, filepath.Join(dir, e.Name()), nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			files = append(files, f)
		}
		seen := map[string]bool{}
		{
			for _, f := range files {
				for _, d := range f.Decls {
					fn, ok := d.(*ast.FuncDecl)
					if !ok || fn.Recv == nil || fn.Body == nil || !fn.Name.IsExported() {
						continue
					}
					direct := callsMutatingClient(fn)
					if !writeMethods[fn.Name.Name] && !direct {
						continue
					}
					seen[fn.Name.Name] = true
					if !callsAudit(fn) {
						t.Errorf("%s: %s writes but never calls audit.Done or audit.Record", dir, fn.Name.Name)
					}
				}
			}
		}
		for _, want := range []string{"Comment", "SetPhase", "PutSpendComment"} {
			if !seen[want] {
				t.Errorf("%s: write method %s not found; the walk is broken", dir, want)
			}
		}
	}
}

func callsAudit(fn *ast.FuncDecl) bool {
	found := false
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok {
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == "audit" && (sel.Sel.Name == "Done" || sel.Sel.Name == "Record") {
				found = true
			}
		}
		return !found
	})
	return found
}

// callsMutatingClient matches t.client.<Service>.<Verb...>(...) with a mutating verb.
func callsMutatingClient(fn *ast.FuncDecl) bool {
	found := false
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		svc, ok := sel.X.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		root, ok := svc.X.(*ast.SelectorExpr)
		if !ok || root.Sel.Name != "client" {
			return true
		}
		for _, v := range mutating {
			if strings.HasPrefix(sel.Sel.Name, v) {
				found = true
			}
		}
		return true
	})
	return found
}
