<!-- factory:question v1 -->
I need an answer to {{count_in_words}} before I can continue, and then I will pick the work back up.

{{#each questions (max 3)}}
**{{n}}. {{question_text}}**
{{#each options (2-3)}}
- **{{letter}}.** {{option_text}}
{{/each}}
I suggest **{{recommended_letter}}**. If you don't reply, I will do this:
{{what_i_will_do_on_default}}
{{/each}}

Reply with your picks (for example `1b 2a`) or free text. Anyone with write
access to this repo can answer; other comments here are not treated as
instructions.
