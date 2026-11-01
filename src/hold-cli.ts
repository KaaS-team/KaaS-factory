// `factory hold <N>` and `factory release <N>`: the commands behind src/hold.ts. Not wired into cli.ts.

import { holdRun, releaseRun } from "./hold";
import { worktreePath } from "./paths";

export function runHoldCommand(verb: "hold" | "release", issue: number, repo: string, who: string): string {
  const dir = worktreePath(issue, process.env, repo);
  if (verb === "hold") {
    holdRun(dir, who);
    return `factory hold: #${issue} held; runner pushes are refused until: factory release ${issue} --repo ${repo}`;
  }
  return releaseRun(dir) ? `factory release: #${issue} released` : `factory release: #${issue} was not held`;
}
