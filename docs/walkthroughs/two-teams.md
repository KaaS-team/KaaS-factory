# Two teams, two resolutions

This walkthrough sets up two team files in one repo and shows how `factory explain` reports which
file set each value. The rules are in [ADR 0001](../adr/0001-team-model.md) and
[ADR 0002](../adr/0002-resolution-rules.md).

1. The org file sets the ceiling for every team. Its `locked` list names the workflows a team may
   not replace.

   `.factory/team/org.yml`

   ```yaml
   name: acme
   locked: [planned-to-pr]
   policy:
     risk_max: medium
     budget_usd_month: 500
   ```

2. Each team is one file under `.factory/team/teams/`. A repo belongs to one team: the file lists
   it under `repos`.

   `.factory/team/teams/payments.yml`

   ```yaml
   name: payments
   repos: [acme/app]
   policy:
     risk_max: high
     budget_usd_month: 200
   roles:
     builder:
       model: sonnet
   ```

3. Ask which file set each key. `explain` needs the issue to exist on GitHub, so run it on a real
   issue number.

   ```
   factory explain <N> --repo <owner/name>
   ```

   The lines for the two policy keys above, produced by the same resolver on a scratch copy of these
   files, read:

   ```
   policy.budget_usd_month = 200 (team)
   policy.risk_max = "medium" (org)
   roles.builder.model = "sonnet" (team)
   ```

   The team asked for `risk_max: high`, but the org set a ceiling of `medium`, and the stricter value
   wins. The budget is the lower of the two: 200 from the team, not 500 from the org.

4. A repo that two team files both list is refused. `applyTeam` reports one problem and keeps the
   builtin and repo values, and `explain` prints that problem on its own line.
