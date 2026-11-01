// Opens one follow-up issue per revert in recent history or reopened issue, never two for the same one.
// Usage: bun scripts/escaped-defects.ts --repo owner/name [--days 2] [--dry-run]
import { followUpIssue, newFollowUps, reopenedIn, revertsIn } from "../src/escaped-defect";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const repo = flag("--repo");
if (!repo) {
  console.error("usage: bun scripts/escaped-defects.ts --repo owner/name [--days 2] [--dry-run]");
  process.exit(2);
}
const days = Number(flag("--days") ?? 2);
const dry = args.includes("--dry-run");

function run(cmd: string[]): string {
  const p = Bun.spawnSync(cmd);
  if (p.exitCode !== 0) {
    console.error(p.stderr.toString().trim());
    process.exit(1);
  }
  return p.stdout.toString();
}

const log = run(["git", "log", `--since=${days} days ago`, "--format=%H%x00%s%x00%b%x1e"]);
const events = JSON.parse(run(["gh", "api", `repos/${repo}/issues/events?per_page=100`])) as unknown[];
const titles = (
  JSON.parse(
    run([
      "gh",
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--search",
      '"Escaped defect:" in:title',
      "--json",
      "title",
      "--limit",
      "1000",
    ]),
  ) as { title: string }[]
).map((t) => t.title);

const since = new Date(Date.now() - days * 86_400_000).toISOString();
const fresh = newFollowUps([...revertsIn(log), ...reopenedIn(events, since)], titles);
for (const e of fresh) {
  const f = followUpIssue(e);
  if (dry) console.log(f.title);
  else run(["gh", "issue", "create", "--repo", repo, "--title", f.title, "--body", f.body]);
}
console.log(`escaped-defects: ${fresh.length} new follow-up(s)`);
