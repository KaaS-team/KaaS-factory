---
name: api-breaking-changes
on:
  cron:
    - schedule: "0 3 * * 4"
      title: Weekly public API breaking-change check
      body: |
        Compare the public API now with the last release: exported names, signatures, CLI flags and
        config keys. List each removal or incompatible change and whether the changelog says so. If
        nothing public changed since the release, triage refuses with "no public change".
stages:
  triage: {}
  done:
    uses: report
    needs: triage
---
A weekly diff of the public API against the last release; it writes findings as comments and opens no PR.
