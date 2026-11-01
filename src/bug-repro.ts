// A bug fix without a reproduction is a guess: at least one acceptance row must fail at base and pass on the branch.

import type { AcceptanceVerdict } from "./acceptance";

const NO_REPRO = "A bug needs at least one acceptance row that fails at base and passes on the branch.";

export function bugReproProblem(type: string | undefined, v: AcceptanceVerdict): string | undefined {
  if (type !== "bug") return undefined;
  return v.acs.some((r) => r.new && r.base === "fail" && r.head === "pass") ? undefined : NO_REPRO;
}

// The problem rides as a verdict error so the table that rejects verify says why.
export function withRepro(v: AcceptanceVerdict, type: string | undefined): AcceptanceVerdict {
  const problem = bugReproProblem(type, v);
  return problem ? { ...v, errors: [...v.errors, problem] } : v;
}
