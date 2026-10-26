// Every commit in a pull request is signed off by its author (the DCO, CONTRIBUTING.md). The core
// is Apache-2.0 with no CLA, so the sign-off is the only record that a contributor had the right.
//
//   bun scripts/dco.ts <base> [head]      fail on any commit in base..head without one (ci.yml)
export interface Commit {
  readonly sha: string;
  readonly email: string;
  readonly body: string;
}

// GitHub's own bots cannot sign; everything else must, with the author's own address.
const BOT = /\[bot\]@users\.noreply\.github\.com$/;

export function unsigned(commits: readonly Commit[]): Commit[] {
  return commits.filter((c) => {
    if (BOT.test(c.email)) return false;
    const trailers = [...c.body.matchAll(/^Signed-off-by: .+ <([^>]+)>\s*$/gm)].map((m) => m[1]!.toLowerCase());
    return !trailers.includes(c.email.toLowerCase());
  });
}

export function commitsBetween(base: string, head: string, cwd = process.cwd()): Commit[] {
  const out = Bun.spawnSync(["git", "log", "--no-merges", "--format=%H%x1f%ae%x1f%B%x1e", `${base}..${head}`], { cwd });
  if (out.exitCode !== 0) throw new Error(`git log ${base}..${head}: ${out.stderr.toString().trim()}`);
  return out.stdout
    .toString()
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, email, body] = r.split("\x1f") as [string, string, string];
      return { sha, email, body };
    });
}

if (import.meta.main) {
  const [base, head = "HEAD"] = process.argv.slice(2);
  if (!base) {
    console.error("usage: bun scripts/dco.ts <base> [head]");
    process.exit(2);
  }
  const bad = unsigned(commitsBetween(base, head));
  for (const c of bad) console.error(`${c.sha.slice(0, 7)} has no Signed-off-by for ${c.email} (git commit -s)`);
  if (bad.length) process.exit(1);
  console.log(`dco: every commit in ${base}..${head} is signed off`);
}
