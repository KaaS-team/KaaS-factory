// Deterministic resolver for the merge conflicts that have a fixed answer.
export interface Rule {
  match: (path: string) => boolean;
  action: "take-main" | "regenerate";
  cmd?: string;
}

export const RULES: Rule[] = [
  { match: (p) => p === "quality-baseline.json", action: "regenerate", cmd: "bun scripts/gen-quality-baseline.ts" },
  { match: (p) => p === "tests/mutation-list.test.ts", action: "take-main" },
  { match: (p) => p === "tests/mutations.json", action: "take-main" },
];

export function ruleFor(path: string): Rule | undefined {
  return RULES.find((r) => r.match(path));
}

export type Run = (cwd: string, argv: string[]) => { code: number; out: string };

export const defaultRun: Run = (cwd, argv) => {
  const p = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
};

export function resolveConflicts(repoDir: string, run: Run = defaultRun): { resolved: string[]; unresolved: string[] } {
  const listed = run(repoDir, ["git", "diff", "--name-only", "--diff-filter=U"]);
  const paths = listed.out.split("\n").filter(Boolean);
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const path of paths) {
    const rule = ruleFor(path);
    if (!rule) {
      unresolved.push(path);
      continue;
    }
    // The worker merges the branch INTO a checkout of main, so "ours" is main's side.
    const steps = [["git", "checkout", "--ours", "--", path]];
    if (rule.cmd) steps.push(["bash", "-c", rule.cmd]);
    steps.push(["git", "add", "--", path]);
    let ok = true;
    for (const argv of steps) {
      if (run(repoDir, argv).code !== 0) {
        ok = false;
        break;
      }
    }
    (ok ? resolved : unresolved).push(path);
  }
  return { resolved, unresolved };
}
