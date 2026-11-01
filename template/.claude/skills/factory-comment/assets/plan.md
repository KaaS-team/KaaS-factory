<!-- factory:plan v1 rev={{rev}} -->
{{one_sentence_what_i_plan_to_do_and_that_i_wait_for_approval}}

## Plan (rev {{rev}})

The goal is to {{one_line_goal}}.

### Acceptance criteria
{{#each ac}}
- **AC-{{n}}:** {{criterion_as_a_short_sentence}}, checked by `{{command_or_test}}`
{{/each}}

### Non-goals (binding; a diff that crosses one fails verify)
{{#each ng}}
- **NG-{{n}}:** {{non_goal_as_a_short_sentence}}
{{/each}}

### Files to touch
{{files_list}}

### Tests to write first
{{#each tests}}
- `{{test_name}}`
{{/each}}

### Repo skills to apply
{{repo_skills_list}} <!-- e.g. handling-money, or "none" -->

### Risk is {{risk}}
{{risk_reasoning_with_charter_citation}}

I will check the build with {{gate_level}}.

{{#if auto_approve_eligible}}
This is low risk, so it can start on its own if auto-approve is on. Otherwise,
reply `/factory approve` to proceed, or `/factory revise <what to change>`.
{{else}}
This needs a person: reply `/factory approve` to proceed, or
`/factory revise <what to change>`.
{{/if}}
