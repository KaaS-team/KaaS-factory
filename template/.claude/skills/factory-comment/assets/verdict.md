<!-- factory:verdict v1 -->

### Acceptance criteria evidence
{{#each ac}}
- **AC-{{n}}:** {{pass|fail|unverified}}: {{evidence_command_and_result}}
{{/each}}

### The test that bites
`{{test_name}}` fails on the base branch ({{failing_output_snippet}}), passes here
(`{{command}}` → {{passing_output_snippet}}).

### Reviewer findings
{{#each findings}}
- {{finding}}
{{/each}}
{{#unless findings}}
None.
{{/unless}}

### Non-goals respected
{{ng_respected_summary}}

{{#if uncertain}}
Uncertain: flagging for a human rather than guessing.
{{/if}}
