Build the thing.

AC-1: it works
AC-2: it is tested

--- ticket T1: Add parser
<!-- factory:planned v1 -->
Deps: T5
## Why
why

## Acceptance
- AC-1: ok

## Files
- `internal/a/a.go`
--- ticket T2: Add store
<!-- factory:planned v1 -->
Deps: none
## Why
why

## Acceptance
- AC-1: ok

## Files
- `internal/b/b.go`
--- ticket T3: Add command
<!-- factory:planned v1 -->
Deps: T1
## Why
why

## Acceptance
- AC-1: ok

## Files
- `internal/c/c.go`
--- ticket T4: Add report
<!-- factory:planned v1 -->
Deps: T1, T2
## Why
why

## Acceptance
- AC-1: ok

## Files
- `internal/d/d.go`
--- ticket T5: Wire it
<!-- factory:planned v1 -->
Deps: T3, T4
## Why
why

## Acceptance
- AC-1: ok

## Files
- `internal/e/e.go`
