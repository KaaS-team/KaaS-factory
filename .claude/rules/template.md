---
paths:
  - "template/**"
  - "template-ci/**"
---

# Template rules

These files run headless in other people's repos. `tests/skills.test.ts`,
`tests/stage-permissions.test.ts` and `tests/template-settings.test.ts` check the first six lines.

- A skill's frontmatter is exactly `name` and `description`: 300 characters or fewer, plain YAML.
  The body is under 90 lines, and names each file in the skill's references directory.
- An agent never lists Edit, Write, MultiEdit or NotebookEdit, and carries `STAGE_GUIDANCE` verbatim.
- Every inline `git`, `bun` or `make` command passes the stage shell rules, and every `git`, `bash`
  or factory script (`template/.factory/gates.sh`, `template/.factory/mutate.sh`) command in a stage skill is on that stage's allow-list.
- No em dash in a skill or agent.
- `[enforced: <hook>]` names a file in `template/.claude/hooks/`, and every hook has a test that runs it.
- Nothing points at one machine: no `/Users/`, `~/.claude` or `$HOME/.claude`.

Judgment, not checked:
- A description says what the skill does and when to use it.
- A command outside those patterns (`gh` in `factory-operator`, which a human runs) still fits its stage.
- Name a reference by its full `.claude/skills/<skill>/references/` path, since a non-Claude agent
  gets the body inlined and runs from the repo root.
- Tag a line `[enforced:]` only when the hook really checks that line, and give each new check a row
  in `tests/mutations.json`.
