---
name: release-notes
on:
  cron:
    - schedule: "0 8 * * 5"
      title: Weekly release notes
      body: |
        Write release notes for every PR merged since the last tag: what changed for a user, grouped
        by feature, fix and breaking change. If nothing merged, triage refuses with "nothing to release".
stages:
  triage: {}
  build:
    needs: triage
  pr:
    needs: build
---
Release notes from merged PRs, as one docs change a person merges.
