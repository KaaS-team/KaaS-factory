# First run: from an issue to a merged PR

This walkthrough follows one issue through the factory once, with the commands a new team runs.
The stages are triage, plan, build, verify and PR. Each stage writes a comment on the issue. The
decisions behind the waits and the merge are in [ADR 0003](../adr/0003-serial-merge-queue.md),
[ADR 0004](../adr/0004-planned-specs-and-stub-guard.md) and
[ADR 0005](../adr/0005-overlap-serialisation.md).

The commands below come from `bun src/cli.ts --help`. A checkout runs them as `bun src/cli.ts`, and
`bin/factory` runs the same CLI.

1. Install the template into the repo. `--dry-run` prints the changes without writing them.

   ```
   factory install <target-dir> [--dry-run] [--update] [--ci] [--agents a,b,c]
   ```

2. Detect the repo's stack and write its gates to `.factory/config.json`.

   ```
   factory init --repo-dir <path> [--dry-run]
   ```

3. Check that the loop can run. `--fix` creates any missing labels.

   ```
   factory doctor --repo-dir <path> [--fix]
   ```

4. Start the loop and the dashboard in one process. Use `--once` to run a single pass and exit.

   ```
   factory up --repo <owner/name>
   factory watch --repo <owner/name> --once
   ```

5. File an issue and add the `factory:ready` label. Triage reads the issue and posts its decision.
   A `needs-info` decision asks a question on the thread, and the run waits for the answer.

6. Follow the run while it works. `--follow` keeps the stream open.

   ```
   factory logs <N> --repo <owner/name> --follow
   ```

7. Answer the factory from GitHub. In a comment on the issue or PR, a trusted person writes
   `/factory approve`, `/factory revise <text>`, `/factory retry` or `/factory cancel`.

8. List what waits for a person.

   ```
   factory inbox --repo <owner/name>
   ```

When verify passes, the runner opens a draft PR. Whether that PR merges on its own depends on the
repo's merge policy. A PR that is not merged waits for a person.
