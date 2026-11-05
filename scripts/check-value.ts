// Which checks and verify rounds ever catch a defect? Reads `factory learn --export` JSONL (a file, or - for
// stdin): `bun scripts/check-value.ts <export.jsonl|->`. Operator numbers: cost never reaches a customer page.
//
// A defect is real when the issue's latest run shipped after a verify reject, so the reject was fixed and
// not given up on. The first reject on that issue is the one that caught it; every later one found nothing
// new. A stage row also lists the checks it ran (gates, holdout, proof, the reviewer, qa), each with pass or
// fail, and a finding names the check that raised it, so the report ranks per check too. A check catches
// when it failed (or raised a finding) on the first stage row of a shipped issue that had any failure. A
// stage row's cost is split evenly over the checks it ran. A stage that records no verdict has no defect signal and is
// listed apart, never as one that caught nothing. This report removes nothing: a removal is its own issue,
// and cites this report.

interface Row {
  type?: string;
  issue?: number;
  stage?: string;
  status?: string;
  started_at?: string;
  cost_usd?: number | null;
  verdict?: string | null;
  checks?: { name: string; result: string }[];
  findings?: { check?: string }[];
}

type Kind = "check" | "stage" | "round";

export interface ValueRow {
  readonly name: string;
  readonly kind: Kind;
  readonly runs: number;
  readonly firstCatches: number;
  readonly costUsd: number;
  readonly unknownCost: number;
}

export interface ValueReport {
  readonly rows: readonly ValueRow[];
  readonly neverFirst: readonly ValueRow[];
  readonly unmeasured: readonly string[];
  readonly realDefects: number;
}

interface Acc {
  kind: Kind;
  runs: number;
  firstCatches: number;
  cost: number;
  unknown: number;
}

const byStart = (a: Row, b: Row): number => (a.started_at ?? "").localeCompare(b.started_at ?? "");

export function checkValue(jsonl: string): ValueReport {
  const rows = jsonl
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
  const latest = new Map<number, Row>();
  const byIssue = new Map<number, Row[]>();
  for (const r of rows) {
    if (r.issue === undefined) continue;
    if (r.type === "run") {
      const prev = latest.get(r.issue);
      if (!prev || byStart(prev, r) <= 0) latest.set(r.issue, r);
    } else if (r.type === "stage" && r.stage) {
      byIssue.set(r.issue, [...(byIssue.get(r.issue) ?? []), r]);
    }
  }

  const acc = new Map<string, Acc>();
  const touch = (name: string, kind: Kind, r: Row, caught: boolean) => {
    const a = acc.get(name) ?? { kind, runs: 0, firstCatches: 0, cost: 0, unknown: 0 };
    a.runs++;
    if (caught) a.firstCatches++;
    if (typeof r.cost_usd === "number") a.cost += r.cost_usd;
    else a.unknown++;
    acc.set(name, a);
  };
  const withVerdict = new Set<string>();
  const stages = new Set<string>();
  let realDefects = 0;

  for (const [issue, stageRuns] of byIssue) {
    const ordered = [...stageRuns].sort(byStart);
    const shipped = latest.get(issue)?.status === "shipped";
    const first = shipped ? ordered.find((s) => s.verdict === "reject") : undefined;
    if (first) realDefects++;
    const failed = (s: Row) =>
      new Set([
        ...(s.checks ?? []).filter((c) => c.result === "fail").map((c) => c.name),
        ...(s.findings ?? []).flatMap((f) => (f.check ? [f.check] : [])),
      ]);
    const firstBad = shipped ? ordered.find((s) => s.verdict === "reject" || failed(s).size > 0) : undefined;
    let round = 0;
    for (const s of ordered) {
      const ran = s.checks ?? [];
      const bad = s === firstBad ? failed(s) : new Set<string>();
      for (const c of ran) {
        const share = { ...s, cost_usd: typeof s.cost_usd === "number" ? s.cost_usd / ran.length : null };
        touch(c.name, "check", share, bad.has(c.name));
      }
      const stage = s.stage as string;
      stages.add(stage);
      if (s.verdict) withVerdict.add(stage);
      touch(stage, "stage", s, s === first);
      if (stage === "verify") touch(`verify round ${++round}`, "round", s, s === first);
    }
  }

  const out: ValueRow[] = [...acc]
    .filter(([name, a]) => a.kind !== "stage" || withVerdict.has(name))
    .map(([name, a]) => ({
      name,
      kind: a.kind,
      runs: a.runs,
      firstCatches: a.firstCatches,
      costUsd: a.cost,
      unknownCost: a.unknown,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return {
    rows: out,
    neverFirst: out.filter((r) => r.firstCatches === 0),
    unmeasured: [...stages].filter((s) => !withVerdict.has(s)).sort(),
    realDefects,
  };
}

export function renderValue(r: ValueReport): string {
  const money = (x: ValueRow) => `$${x.costUsd.toFixed(2)}${x.unknownCost ? ` (+${x.unknownCost} unpriced)` : ""}`;
  return [
    `Real defects (a reject, then shipped): ${r.realDefects}`,
    "",
    "| Check | Kind | Runs | First to catch | Cost |",
    "|---|---|---|---|---|",
    ...r.rows.map((x) => `| ${x.name} | ${x.kind} | ${x.runs} | ${x.firstCatches} | ${money(x)} |`),
    "",
    "Never first to catch a real defect:",
    ...(r.neverFirst.length
      ? r.neverFirst.map((x) => `- ${x.name} (${x.kind}): ${x.runs} runs, ${money(x)}`)
      : ["- none"]),
    "",
    `No verdict recorded, so no defect signal (not the same as catching nothing): ${r.unmeasured.join(", ") || "none"}`,
    "",
    "A removal is its own issue and cites this report.",
  ].join("\n");
}

if (import.meta.main) {
  const src = process.argv[2];
  if (!src) {
    console.error("usage: bun scripts/check-value.ts <export.jsonl|->");
    process.exit(2);
  }
  const text = src === "-" ? await Bun.stdin.text() : await Bun.file(src).text();
  console.log(renderValue(checkValue(text)));
}
