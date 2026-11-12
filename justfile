# The gate. `just check` is what CI and the pre-push hook run; it must end with zero errors and zero warnings.
# lint runs through gate.sh: the PATH golangci-lint only when it is exactly lint_version, otherwise `go run` at the pin.
# gate.sh is the fallback for hosts without just; tools/gate checks its steps and the pin against this file and go.yml.

lint_version := "v2.13.2"
# golangci-lint v2.13.2 is built with Go 1.26 and cannot type-check a newer standard library.
lint_go := "go1.26.7"

default: check

# Full gate: format, vet, lint, race tests (includes the provenance test), static build, ratchet.
check: fmt vet lint test build ratchet

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
    ./gate.sh lint

# Fails when non-test Go lines or deadcode entries exceed .ratchet.json; `go run ./tools/ratchet --update` lowers it.
ratchet:
    go run ./tools/ratchet

test:
    go test -race ./...
    go vet -tags ee ./... && go test -race -tags ee ./...

build:
    CGO_ENABLED=0 go build -o dist/factory ./cmd/factory
