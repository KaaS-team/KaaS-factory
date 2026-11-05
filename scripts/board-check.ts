// Readiness check for the issue board: `bun scripts/board-check.ts --repo owner/name [--required]`.
// Every open issue must be a complete spec, a planned marker must come with a real plan, and an epic
// must list children that exist and are open. Report-only unless --required, which exits 1 on a finding.
// It does not judge whether a spec is good, only whether the parts are there.

import { LABEL } from "../src/labels";
import { parsePlannedIssue, PLANNED_MARKER } from "../src/engine/import-plan";

export interface BoardIssue {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly milestone: string | null;
  // Native sub-issues, the source of truth for an epic's children.
  readonly subIssues: readonly number[];
}

export interface Finding {
  readonly issue: number;
  readonly rule: Rule;
  readonly message: string;
}

export const RULES = ["sections", "plan-marker", "epic-children", "milestone"] as const;
export type Rule = (typeof RULES)[number];

export const SECTIONS = ["Problem", "Acceptance", "Out of scope"] as const;
export const EPIC_LABEL = "epic";
export const LATER_LABEL = "later";
// The label a body marker has a twin in; the runner does not define it, so the check names it here.
export const PLANNED_LABEL = "factory:planned";

const headings = (body: string): string[] =>
  [...body.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => (m[1] ?? "").trim().toLowerCase());

const isLedger = (i: BoardIssue): boolean => i.labels.includes(LABEL.ledger);

export function checkBoard(issues: readonly BoardIssue[]): Finding[] {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const out: Finding[] = [];
  for (const i of issues) {
    if (i.state !== "open" || isLedger(i)) continue;
    const add = (rule: Rule, message: string) => out.push({ issue: i.number, rule, message });

    // A planned marker or label skips the plan stage, so the body must hold a plan that parses cleanly.
    // Such a body is its own spec (Why, Change, Acceptance), so the three headings are not asked of it.
    let planned = false;
    if (i.body.includes(PLANNED_MARKER) || i.labels.includes(PLANNED_LABEL)) {
      const { plan, problems } = parsePlannedIssue(i.body);
      planned = !!plan && problems.length === 0;
      if (!planned) add("plan-marker", `skips the plan stage without a hand-made plan: ${problems[0] ?? "no plan"}`);
    }

    const have = headings(i.body);
    for (const s of SECTIONS) {
      if (!planned && !have.some((h) => h.startsWith(s.toLowerCase()))) add("sections", `no ${s} section`);
    }

    if (i.labels.includes(EPIC_LABEL)) {
      if (!i.subIssues.length) add("epic-children", "epic has no native sub-issues");
      for (const n of i.subIssues) {
        const child = byNumber.get(n);
        if (!child) add("epic-children", `child #${n} does not exist`);
        else if (child.state === "closed") add("epic-children", `child #${n} is closed`);
      }
      // A checklist line that is not a real issue is a child that does not exist.
      for (const m of i.body.matchAll(/^\s*[-*]\s*\[[ xX]\]\s*#(\d+)/gm)) {
        const n = Number(m[1]);
        if (!byNumber.has(n) && !i.subIssues.includes(n)) add("epic-children", `child #${n} does not exist`);
      }
    }

    if (!i.milestone && !i.labels.includes(LATER_LABEL)) add("milestone", "no milestone");
  }
  return out;
}

function gh(args: string[]): string {
  const p = Bun.spawnSync(["gh", ...args]);
  if (p.exitCode !== 0) {
    console.error(p.stderr.toString().trim());
    process.exit(2);
  }
  return p.stdout.toString();
}

interface RawIssue {
  number: number;
  state: string;
  title: string;
  body: string | null;
  labels: { name: string }[];
  milestone: { title: string } | null;
  pull_request?: unknown;
  sub_issues_summary?: { total: number };
}

export function fetchBoard(repo: string): BoardIssue[] {
  const raw = (
    JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/issues?state=all&per_page=100`])) as RawIssue[][]
  )
    .flat()
    .filter((r) => !r.pull_request);
  return raw.map((r) => {
    const subs = r.sub_issues_summary?.total
      ? (
          JSON.parse(
            gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${r.number}/sub_issues?per_page=100`]),
          ) as { number: number }[][]
        )
          .flat()
          .map((s) => s.number)
      : [];
    return {
      number: r.number,
      state: r.state === "closed" ? "closed" : "open",
      title: r.title,
      body: r.body ?? "",
      labels: r.labels.map((l) => l.name),
      milestone: r.milestone?.title ?? null,
      subIssues: subs,
    };
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
  const repo = flag("--repo");
  const file = flag("--file");
  if (!repo && !file) {
    console.error("usage: bun scripts/board-check.ts (--repo owner/name | --file board.json) [--required]");
    process.exit(2);
  }
  const board = file ? (JSON.parse(await Bun.file(file).text()) as BoardIssue[]) : fetchBoard(repo as string);
  const findings = checkBoard(board);
  for (const f of findings) console.log(`#${f.issue} [${f.rule}] ${f.message}`);
  console.log(`board-check: ${findings.length} finding(s)`);
  process.exit(args.includes("--required") && findings.length ? 1 : 0);
}
