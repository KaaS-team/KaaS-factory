// Usage: bun scripts/merge-worker.ts <branch>   (run in a checkout; never pushes)
import { defaultRun, resolveConflicts } from "../src/merge-resolve";

const branch = process.argv[2];
if (!branch) {
  console.error("usage: merge-worker.ts <branch>");
  process.exit(1);
}
const cwd = process.cwd();
const git = (...args: string[]) => defaultRun(cwd, ["git", ...args]);
for (const args of [
  ["fetch", "origin", "main", branch],
  ["checkout", "-B", "work", "origin/main"],
]) {
  const r = git(...args);
  if (r.code !== 0) {
    console.error(r.out);
    process.exit(1);
  }
}
const merge = git("merge", "--no-ff", "--no-commit", `origin/${branch}`);
if (merge.code !== 0 && !merge.out.includes("CONFLICT")) {
  console.error(merge.out);
  git("merge", "--abort");
  process.exit(1);
}
const { resolved, unresolved } = resolveConflicts(cwd);
if (unresolved.length > 0) {
  git("merge", "--abort");
  for (const p of unresolved) console.log(`unresolved: ${p}`);
  process.exit(2);
}
const commit = git("commit", "-s", "--no-edit");
if (commit.code !== 0) {
  console.error(commit.out);
  process.exit(1);
}
console.log(`resolved ${resolved.length}, ready`);
