#!/bin/sh
# The gate for hosts without `just`: the same steps as the justfile `check` recipe, in the same order.
# tools/gate/gate_test.go fails when the two lists differ. The lint pin is read from the justfile.
set -eu
cd "$(dirname "$0")"

STEPS="fmt vet lint test build ratchet"

pin() { sed -n "s/^$1 := \"\\(.*\\)\"\$/\\1/p" justfile; }

step_fmt() {
	# The pinned toolchain's gofmt, the one golangci-lint formats with: a newer gofmt on PATH can disagree.
	fmt="$(GOTOOLCHAIN=$(pin lint_go) go env GOROOT)/bin/gofmt"
	bad=$("$fmt" -l $(git ls-files -co --exclude-standard '*.go'))
	if [ -n "$bad" ]; then echo "gofmt needed:"; echo "$bad"; exit 1; fi
}
step_vet() { go vet ./...; }
step_lint() {
	ver=$(pin lint_version)
	GOTOOLCHAIN=$(pin lint_go)
	export GOTOOLCHAIN
	# The PATH binary counts only when it is exactly the pinned version.
	if command -v golangci-lint >/dev/null 2>&1 &&
		golangci-lint version 2>&1 | grep -q "has version ${ver#v} "; then
		golangci-lint run ./...
	else
		go run "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$ver" run ./...
	fi
}
step_test() {
	go test -race ./...
	go vet -tags ee ./... && go test -race -tags ee ./...
}
step_build() { CGO_ENABLED=0 go build -o dist/factory ./cmd/factory; }
step_ratchet() { go run ./tools/ratchet; }

for s in ${1:-$STEPS}; do "step_$s"; done
