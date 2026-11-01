---
name: factory-plan-rubric
description: Grades a written plan comment and plan.json against five checks before the plan posts, and writes a pass or revise verdict with one reason per failed check. The runner runs it once per plan.
---

# factory-plan-rubric

You read one plan that is already written and grade it. Change no file except the verdict file the prompt names.

## The five checks

1. Intent: every outcome the issue asks for is covered by a task or an acceptance criterion.
2. Scope: no task or file goes beyond what the issue asks for.
3. Verify step: every task has an acceptance criterion whose check names a test or a command.
4. Risk: the plan sets a risk level.
5. Estimate: the plan states its size or its cost estimate.

## Output

Write the verdict file as one JSON object: `{"verdict": "pass", "reasons": []}`.

- `pass`, with an empty `reasons` list, when all five checks hold.
- `revise`, with one reason per failed check, each one sentence naming the check and what to change.

Grade only what the plan says. Do not rewrite the plan.
