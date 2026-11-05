---
name: docs-drift
on:
  cron:
    - schedule: "0 6 * * 3"
      title: Weekly docs drift check
      body: |
        Compare the docs with the code they describe: commands, flags, config keys and file paths.
        List each statement the code no longer backs, with the doc line and the code that disagrees.
        If every statement still matches, triage refuses with "docs match the code".
stages:
  triage: {}
  done:
    uses: report
    needs: triage
---
A weekly check for docs that no longer match the code; it writes findings as comments and opens no PR.
