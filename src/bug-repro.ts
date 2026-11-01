// A bug fix without a reproduction is a guess: at least one acceptance row must fail at base and pass on the branch.

import { type AcceptanceVerdict, planAcceptance } from "./acceptance";
import { readRunJson } from "./engine/verdict-rules";
import type { PlanArtifact } from "./artifacts";

export function bugReproProblem(type: string | undefined, v: AcceptanceVerdict): string | undefined {
  if (type !== "bug") return undefined;
  const reproduced = v.acs.some((r) => r.new && r.base === "fail" && r.head === "pass");
  return reproduced
    ? undefined
    : "A bug needs at least one acceptance row that fails at base and passes on the branch.";
}

// The verdict verify judges: the plan's own rows, plus an error when a bug has no reproduction, so the
// table that rejects verify says why.
export function ownVerdict(
  kit: AcceptanceVerdict,
  worktree: string,
  issueNumber: number,
  type: string | undefined,
): AcceptanceVerdict | undefined {
  const plan = readRunJson<PlanArtifact>(worktree, issueNumber, "plan.json");
  const own = planAcceptance(kit, plan);
  const problem = bugReproProblem(type, own ?? { ...kit, acs: [], errors: [] });
  return problem && own ? { ...own, errors: [...own.errors, problem] } : own;
}
