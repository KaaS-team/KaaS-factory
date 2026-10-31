<!-- factory:planned v1 -->
## Why
A repo that runs a Codex or Gemini agent keeps its skills under `.agents/skills`, not `.claude/skills`. The agent presets already name that directory, but the context pack and the config check still look only in `.claude/skills`. So the repo skills index is empty and a route naming an `.agents/skills` skill is refused at startup as "not found". This epic makes both read the directory the agent's preset names.

## Today
- `src/agents/types.ts:62` `AgentPreset.skillsDir` and `:63` `contextFile` already exist for every preset.
- `src/context.ts:38` `PackOptions` has `skills?` and `contextFile?` but no skills directory.
- `src/context.ts:94`, `:102` (`skillsIndex`) and `:137` (the `routeSkills` block) read the literal `${cwd}/.claude/skills`.
- `src/agents/executor.ts` passes `{ skills, contextFile: agent.preset?.contextFile }` to `buildContextPack`.
- `src/config.ts:726` checks a route's skill with `existsSync(`${targetRepoDir}/.claude/skills/${name}/SKILL.md`)` only.
- `src/harness-defaults.ts:46` `resolveSkill(cwd, name, skillsDir?)` already searches `.claude/skills`, `.agents/skills` and `skillsDir`.

## Change
### T1: Context pack reads the agent's skills directory
Files: `src/context.ts`, `src/agents/executor.ts`, `tests/context-pack.test.ts`
Model: sonnet
1. Add `readonly skillsDir?: string` to `PackOptions` (default `.claude/skills`).
2. Make `skillsIndex(cwd, skillsDir = ".claude/skills")` read `${cwd}/${skillsDir}` and each `SKILL.md` under it, and make the `routeSkills` block read the same directory.
3. In `src/agents/executor.ts`, pass `skillsDir: agent.preset?.skillsDir` alongside `contextFile` in the `buildContextPack` options.
4. Keep the `if (body) out.push({ label: `skill: ${name}`` line as it is.

### T2: Config check accepts either skills directory
Files: `src/config.ts`, `tests/routes.test.ts`
Model: sonnet
1. In the route-skill check at `src/config.ts:726`, accept a skill present under `.claude/skills` or `.agents/skills`, and name both directories in the "not found" message.

## Tests
- `tests/context-pack.test.ts`: [permanent] with `skillsDir: ".agents/skills"` the index lists a skill from that directory and not one under `.claude/skills`; a routed skill is read from it; the default still reads `.claude/skills`.
- `tests/routes.test.ts`: [permanent] a route skill that exists only under `.agents/skills` passes the check; a missing one names both directories.

## Mutation
```json
{"name":"context: routed skill never added","file":"src/context.ts","find":"if (body) out.push({ label: `skill: ${name}`","replace":"if (!body) out.push({ label: `skill: ${name}`","test":"tests/context-pack.test.ts"}
```

## Acceptance
- AC-1: the context pack lists and routes skills from the agent's `skillsDir`: checked by `make test FILES="tests/context-pack.test.ts"` (T1)
- AC-2: a route skill under `.agents/skills` passes the config check: checked by `make test FILES="tests/routes.test.ts"` (T2)
- AC-3: the whole gate stays green: checked by `make check` (T2)

## Non-goals
- NG-1: no change to `src/learn.ts`, `src/teach.ts` or `src/harness-defaults.ts`; their `.claude/skills` literals are allowed-path lists for a claude-owned directory.
- NG-2: no move of `resumeArgv` onto the preset; follow-up issue.

## Files
- `src/context.ts`
- `src/agents/executor.ts`
- `src/config.ts`
- `tests/context-pack.test.ts`
- `tests/routes.test.ts`

## Risk: low
## Model: sonnet

