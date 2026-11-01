<!-- factory:triage v1 -->
{{one_sentence_what_i_decided_and_what_happens_next}}

## Triage

This looks like a {{type}} ({{risk}} risk), and I am {{confidence_in_words}} about that. <!-- type: bug | feature | docs | security | dependency; risk: low | medium | high -->

Disposition: {{disposition}}. <!-- proceed | needs-info | refused | duplicate -->

It is done when {{done_when}}.

I expect to touch {{files_expected_list}}, and I will check it with {{gate_level}}.

{{#if refused}}
I refused this one because it crosses a protected boundary:

> {{charter_rule_quoted_verbatim}}

A human needs to decide it.
{{/if}}

{{#if duplicate}}
This repeats #{{duplicate_of}}, so I am stopping here. Please follow that issue.
{{/if}}

{{#if needs_info}}
I can't write a checkable "done when" yet, so I have a question below.
{{/if}}
