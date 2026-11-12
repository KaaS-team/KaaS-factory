BRANCH: go/config
HEAD: c45f07418fb9c23f549a29cbfc097ecb7088aef5
## Summary
`internal/config` resolves 27 keys (plus open `models.<tier>` keys) across builtin, org, team, repo, `FACTORY_*` env and flags, with the org layer as a ceiling and `Explain` for provenance. koanf v2.3.6 with its yaml, env and posflag providers does the parsing; ceilings, unknown-key checks and coercion are in this package.
## Acceptance
- Layering table test: each key set at each layer wins over the layer below it -> TestLayering_EachLayerWinsOverTheOneBelow (every key, five layers), TestLayering_LayerRowsCoverEveryKey -> done
- Ceiling: team raising `budgets.team_day` above org fails naming org and team; lowering passes -> TestCeiling_OrgBoundsLowerLayers (rows `budgets.team_day` 100/200, 100/50, 100/100, at team, repo, env and flags) -> done
- Unknown key in any layer fails with its full path -> TestUnknownKey_FailsWithFullPathInEveryLayer -> done
- `Explain("slots")` names the winning layer and the layers it overrode -> TestExplain_SlotsNamesWinnerAndOverriddenLayers -> done
- A factory-config org YAML from its repo fixtures loads without error -> TestFactoryConfigFixtures_OrgAndEveryTeamLoad (org.yml and all six team files, copied to `testdata/factory-config/` with PROVENANCE.md at factory-config@2ebcf53) -> done
- `.factory/config.json` as repo-layer alias when `factory.yaml` is absent -> TestReadRepo, TestReadRepo_JSONAliasLoadsAsRepoLayer -> done (the alias reads the same key names; the real products/kaas file was not available, see Learnings)
## API change requests
none
## Files outside my area
- `go.mod`, `go.sum`: koanf v2.3.6 and its yaml, env/v2, posflag, rawbytes providers (the ticket names the dependency).
## Gate evidence
`just` is not installed here, so the recipe bodies were run by hand:
gofmt -l: no output
go vet ./...: no output
golangci-lint v2.13.2 (go run): 0 issues.
go test -race ./...:
ok  	github.com/KaaS-team/factory/cmd/factory	1.017s
ok  	github.com/KaaS-team/factory/internal/api/porttest	1.011s
ok  	github.com/KaaS-team/factory/internal/config	1.152s
ok  	github.com/KaaS-team/factory/internal/provenance	1.031s
CGO_ENABLED=0 go build -o dist/factory ./cmd/factory: build ok
## Learnings
- The brief said ADRs 0001/0002 and `playbooks` (symphony-spec.md) were readable; factory-config has no ADRs and `git clone` of both repos failed without `add_repo`. I added only factory-config, so tests cite Symphony §6 from memory of the brief, not the spec text. The brief should name the repos to attach.
- factory-config's org.yml uses a different schema (policy.*, locked, teams), so the ticket's "loads without error" needed a policy-alias table; say in the ticket which schema the org layer reads.
- `FACTORY_*` env vars that are not keys now fail loading, per "unknown key in any layer". Ambient vars such as FACTORY_RUNNER_REF would break a run; decide whether env should ignore unknown names.
- products/kaas `.factory/config.json` was not reachable; if it uses the old camelCase TS keys it will fail as unknown keys until a mapping is added.
- `just` was missing in the cloud image; install it in the environment setup.
