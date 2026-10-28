---
name: factory-retro
description: Reads a finished run (merged, closed by a human, or given up on after too many verify rejections) and proposes at most one lesson or skill edit, or none. Use as the last stage, after the run has already reached its final outcome; it never changes the run's result.
---

# factory-retro

Invoked as `/factory-retro <N>`. Read-only: no code edit, no push, no `gh`
access. The outcome is already decided.

## 1. Read the inputs

- `.factory/runs/issue-<N>/issue.json` and every stage artifact and comment
  the run produced. Recorded lessons are in your context pack: don't repeat one.

## 2. Decide whether there is a lesson

Look for one concrete, reusable thing, in these places:

- **navigation**: many calls spent finding a file; a pointer would have saved them.
- **check**: an automated check would have caught it. Read the repo's own
  `make check`, CI and `.agents/repo.json` first; an unwired check is the finding.
- **standard**: the reviewer missed a violation. A *mechanical* one gets a
  deterministic check, never a prose rule. Only a *judgement* call becomes a
  line in `CODING_STANDARDS.md` (the reviewer reads it, the builder does not).
- **steering**: an always-loaded file carries a rule that belongs in a check,
  or an instruction that changes no behaviour. Propose moving or deleting it.
- **tool economy**: one expensive call a cheaper one would have replaced.
- **information**: the answer was not reachable (a log, a service, a doc).

Most runs teach nothing; saying so is expected. Propose at most one of:
- **a lesson** for `.factory/memory/lessons.md`, opening with its place in
  brackets, such as `[check]`; a mechanical violation names the check to build;
- **a skill edit**: a named skill and the wording change that would have helped.

Never both. If nothing rises above "specific to this one issue," propose none.

## 3. Write the output

Write `.factory/runs/issue-<N>/retro.json`:

```json
{ "lesson": "{{lesson_text_or_omit}}", "skill_name": "{{skill_or_omit}}", "skill_edit": "{{edit_text_or_omit}}", "outcome": "complete", "summary": "{{one_line}}" }
```

Omit `lesson` and `skill_name`/`skill_edit` entirely when you are proposing
nothing; never propose a lesson and a skill edit together. Then write
`.factory/runs/issue-<N>/retro-comment.md`: one or two sentences on what you
propose and why. Nothing is applied automatically; `factory learn` reviews it.
