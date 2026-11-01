# Two green PRs wait

This walkthrough follows two pull requests on one repo that both pass their gates. The decision is in
[ADR 0003](../adr/0003-serial-merge-queue.md).

1. Both PRs reach the merge step with their gates green. The merge step asks the queue to merge
   each one. The first PR takes the repo's lease.

2. The first PR is rebased onto the latest base. The head did not move, so the queue confirms the
   head is the one the merge decision was made for, and merges it.

3. The second PR asks for the lease while the first still holds it. The queue returns `busy`, and
   the merge step reports no merge for that pass.

4. After the first merge, the base has moved. When the second PR's turn comes, the rebase changes its
   head. The queue returns `rebased` and does not merge. The merge waits for the next poll, and the
   gates run again on the new head during that poll.

5. The second PR merges once its gates pass on the rebased head.

To see the steps for a PR, read its run log.

```
factory logs <N> --repo <owner/name> [--stage <name>] [--json]
```

A rebase that the platform refuses to push is the one failure a person must see. The queue posts a
comment that says the merge was not attempted, and the log keeps the rest.
