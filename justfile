# The gate. `just check` is what CI and the pre-push hook run; it must end with zero errors and zero warnings.
# golangci-lint runs from PATH when installed, otherwise at the pinned version through `go run`.

lint_version := "v2.13.2"
# golangci-lint v2.13.2 is built with Go 1.26 and cannot type-check a newer standard library.
lint_go := "go1.26.7"

default: check

# Full gate: format, vet, lint, race tests (includes the provenance test), static build.
check: fmt vet lint test build

# Inner loop: format, vet and tests without -race or lint.
fast: fmt vet
    go test ./...

fmt:
    #!/usr/bin/env bash
    set -euo pipefail
    bad=$(gofmt -l $(git ls-files -co --exclude-standard '*.go'))
    if [ -n "$bad" ]; then echo "gofmt needed:"; echo "$bad"; exit 1; fi

vet:
    go vet ./...

lint:
    #!/usr/bin/env bash
    set -euo pipefail
    export GOTOOLCHAIN={{lint_go}}
    if command -v golangci-lint >/dev/null; then golangci-lint run ./...
    else go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@{{lint_version}} run ./...; fi

test:
    go test -race ./...
    go vet -tags ee ./... && go test -race -tags ee ./...

build:
    CGO_ENABLED=0 go build -o dist/factory ./cmd/factory
