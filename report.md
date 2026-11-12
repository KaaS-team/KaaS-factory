BRANCH: go/k5-sandbox-limits
HEAD: 9b043f58b8f02de08cd723c6a6f84a77eaead098
## Summary
Added two-layer rlimits (Spec.Baseline, Spec.Exec) with a name whitelist checked in Command, moved process-group kill into pkg/sandbox (Command uses it, dispatch/local reuses it), and wrote the jail audit with the bubblewrap flag diff in pkg/sandbox/AUDIT.md. Truncation, session id key and the upstream-port rows were left out (below). Nothing was ported from upstream code, so there is no THIRD_PARTY_NOTICES change.
## Acceptance
- rlimit: whitelist of resource names -> TestValidateLimits, TestEveryNameHasAResource -> done
- rlimit: unknown name fails at session start with a clear error -> TestCommandRejectsUnknownLimit -> done
- rlimit: child inherits baseline; per-exec override -> TestBaselineInheritedAndExecOverrides, TestMergeLimits -> done
- rlimit: RLIMIT_NPROC and RLIMIT_AS enforced -> TestRlimitNproc (runs as uid 65534 when root, skips when not root), TestRlimitAS -> done
- timeout kills the whole process group, grandchild test -> TestTimeoutKillsGrandchild -> done
- jailer checklist table present/absent -> AUDIT.md, TestAuditTable -> done; gaps are listed in AUDIT.md, not filed as tickets (I may not touch issues)
- audit keyed by session id (max 64 chars) -> blocked: the jail has no session id; recorded as a gap
- bwrap profile documented with a diff against the upstream list -> AUDIT.md -> done (we use Landlock, so most flags are marked absent)
- tool output truncated at a configurable cap (head and tail) with a narrowing hint -> blocked: no tool-output consumer exists in the Go tree, and an uncalled function would be unreachable from cmd/factory. Belongs with the bare-bash arm.
- Not done: the firecracker-gvisor #2 table is covered above; microsandbox #2 whitelist/baseline done. Other tickets belong to other sessions.
Bite-check (revert, watch it fail, restore): no Setpgid and group-less kill -> TestTimeoutKillsGrandchild fails; validation disabled -> TestValidateLimits and TestCommandRejectsUnknownLimit fail; baseline beats exec -> TestMergeLimits and TestBaselineInheritedAndExecOverrides fail; limits not applied -> TestMakePlan, TestBaselineInheritedAndExecOverrides, TestRlimitNproc fail. I did not separately revert the AS test.
## Measures
- Non-test Go lines before and after: 20357 -> 20401 (+44; the audit table and tests do not count).
- Deadcode lines before and after: 68 -> 68.
## API change requests
none
## Files outside my area
- internal/dispatch/local/local.go (3 call sites) and deleted internal/dispatch/local/proc_unix.go and proc_other.go: they duplicated the group kill now in pkg/sandbox, so one resolver remains.
- Replaced the Max* fields of Spec with Baseline/Exec, so any other session using MaxMemBytes, MaxCPUSeconds or MaxProcs must switch. None existed on next at the time.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand with GOTOOLCHAIN=go1.26.7: gofmt -l (empty), go vet ./... (clean), golangci-lint v2.13.2 ("0 issues."), go test -race ./... (all ok, last line "ok  github.com/KaaS-team/factory/pkg/sandbox  2.928s"), CGO_ENABLED=0 go build ./cmd/factory ("BUILD OK").
## Learnings
- dash runs `sh -c "sh -c true"` without forking, so an NPROC test must background a child (`true & wait`).
- RLIMIT_NPROC is not enforced for root; the test must drop to uid 65534 with a copy of the test binary in a world-readable dir.
- Chaining a lint run into `| tail` hides its exit code; the factory's brief should say to read the "0 issues." line.
- I made one commit, not one per group, because the groups share sandbox.go and the first commit would not build alone.
