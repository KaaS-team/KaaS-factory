BRANCH: cluster/v7.0-agents-plugins
HEAD: ea94e37cdd5edb9048392702adcbc8c376a2ed70
## Summary
All eight agent presets now live in contrib/agents and register themselves; the lwpr runtime is a plugin on a new runtime registry that the core runs without when it is disabled.
## Issues
- #590: done.
  - Each preset is a plugin that registers itself -> tests/agent-plugins.test.ts "loading contrib/agents/<name> alone registers it" (8 cases) -> tests/mutations/a-preset-module-does-not-register-itself.json. The old a-shipped-agent-is-left-out mutation was re-pointed at the codex register call.
  - Old core paths removed and pinned -> tests/agent-plugins.test.ts "the old core paths are gone and the index holds no preset table" -> tests/mutations/the-claude-preset-returns-to-the-core-presets-directory.json.
  - Behaviour unchanged -> existing tests (agents, executor, mcp, stage-permissions, takeover, minion, ported/*, plugin-registry, core-names-no-agent, contrib-agents) pass; only import paths changed. Mutation: n/a.
- #591: done.
  - Registers through the registry -> tests/runtime-plugins.test.ts "it registers through the registry and is a built-in runtime" -> the-lwpr-plugin-does-not-register-with-the-runtime-registry.json.
  - Core starts with the plugin disabled -> "with the plugin disabled the core starts with local only..." (FACTORY_DISABLE_PLUGINS=lwpr, fresh process) -> disabling-the-lwpr-plugin-is-ignored.json.
  - Direct import fails a test -> "no core file imports the plugin except the one loader" -> core-imports-the-lwpr-plugin-directly.json.
  - Caveat: "passes its tests with the plugin disabled" is shown by the subprocess test, not by running the whole suite with the env var set. Many existing tests assume lwpr exists.
## Staged workflow changes
none
## Checkpoints
#590 and #591: 1 yes (outside files named below), 2 yes, 3 yes, 4 yes (mutations bite), 5 yes (no cap raised; the claude comment-baseline shard was renamed, same count), 6 yes (neighbour tests run), 7 yes.
Behaviour changes in #591: the runtime-kind error message lists lwpr last ("..., pool, lwpr"); tests/runtimes.test.ts expectation updated. BUILTIN_RUNTIMES and RUNTIME_KINDS became builtinRuntimes() and runtimeKinds(), because plugin kinds register later.
## Files outside my area
- src/plugins/registry.ts, src/plugins/loader.ts: new "runtime" plugin kind and its loader branch.
- src/sandbox.ts: lwpr capabilities now come from the plugin; adds allCapabilities().
- src/runtimes-shipped.ts (new): the one loader file for shipped runtime plugins; honours FACTORY_DISABLE_PLUGINS.
- dashboard/project.ts: BUILTIN_RUNTIMES to builtinRuntimes().
- AGENTS.md, src/agents/prompt.ts: claude.ts path moved to contrib/agents/claude.ts.
- Many tests and tests/mutations.json: import and path updates.
## Gate evidence
make fast: ok
## Risk and rollback
Medium-low. Risk is a missed import of the moved presets or a runtime kind assumed always present. Roll back by reverting the two commits.
## Learnings
- The brief's "Blocked by #588" is stale: the spine is in the base.
- src/runtimes.ts consumers elsewhere (dashboard/project.ts, tests) used BUILTIN_RUNTIMES and RUNTIME_KINDS; grep these before changing runtime exports.
- biome strips a non-null "!" in tests, which then fails tsc; run tsc after biome --write.
- make fast reports a biome warning in src/mc/fake-adapter.ts (unused SessionRef) that comes from the base branch, not this work.
- Factory defaults: the brief should name the runtime registry kind, since "runtime" did not exist in PluginKind.
