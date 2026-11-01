<!-- factory:verdict v1 -->
{{one_sentence_pass_reject_or_uncertain_and_what_happens_next}}

### What I found for each criterion
{{#each ac}}
- {{criterion_as_a_short_sentence}} It {{passes|fails|is unverified}}: {{evidence_command_and_result}}
{{/each}}

### The test that proves it
`{{test_name}}` fails on the base branch ({{failing_output_snippet}}) and passes here
(`{{command}}` gave {{passing_output_snippet}}).

### What the reviewer found
{{#each findings}}
- {{finding_as_a_short_sentence}}
{{/each}}
{{#unless findings}}
The reviewer found nothing to fix.
{{/unless}}

### The non-goals held
{{ng_respected_summary}}

{{#if uncertain}}
I am not sure about this one, so I am flagging it for a person rather than guessing.
{{/if}}
