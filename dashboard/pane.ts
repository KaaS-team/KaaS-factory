// The run page's right pane: risk in words, the preview, and the cost. Cost and models are operator
// detail, so the server leaves them out for anyone below operator instead of trusting the page to hide them.
import { join } from "node:path";
import { plain } from "../src/display";
import { readGateEvidence, readStageArtifacts } from "../src/artifacts";
import { type Actor, type Route } from "./plane/access";
import { atLeast } from "./plane/store";

export interface PaneInput {
  triage?: { risk?: string; confidence?: number; files_expected?: string[] } | null;
  plan?: { risk?: string; files?: string[]; autoApproveEligible?: boolean } | null;
  build?: {
    status?: string;
    rounds?: number;
    screenshots?: { state?: string; viewport?: string; theme?: string }[];
  } | null;
  verify?: { result?: string; findings?: unknown[] } | null;
  gate?: { status: string } | null;
  stages: readonly {
    stage: string;
    agent: string;
    model?: string | null;
    cost_usd: number | null;
    ok?: number | null;
  }[];
  prUrl?: string | null;
}

export interface Pane {
  risk: { level: "low" | "medium" | "high" | "unknown"; signals: string[] };
  preview: { prUrl: string | null; shots: { state: string; viewport: string; theme: string }[]; pairs: string[] };
  cost: { totalUsd: number; stages: { stage: string; agent: string; model: string; costUsd: number }[] } | null;
}

const LEVELS = ["low", "medium", "high"] as const;
type Level = (typeof LEVELS)[number];
const levelOf = (v: unknown): Level | null => (LEVELS.includes(v as Level) ? (v as Level) : null);
const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

export function riskLevel(input: Pick<PaneInput, "triage" | "plan">): Level | "unknown" {
  const reported = [levelOf(input.triage?.risk), levelOf(input.plan?.risk)].filter((l): l is Level => l !== null);
  return reported.length ? LEVELS[Math.max(...reported.map((l) => LEVELS.indexOf(l)))]! : "unknown";
}

// Each signal is a sentence a PM can act on; the level is the worst one the stages reported.
export function paneView(input: PaneInput, operator: boolean): Pane {
  const signals: string[] = [];
  const level = riskLevel(input);
  if (input.plan?.risk) signals.push(`The plan rates this change ${input.plan.risk} risk.`);
  else if (input.triage?.risk) signals.push(`Triage rates this change ${input.triage.risk} risk.`);
  const touched = input.plan?.files?.length ?? input.triage?.files_expected?.length;
  if (touched) signals.push(`It touches ${files(touched)}.`);
  if (typeof input.triage?.confidence === "number")
    signals.push(`Triage is ${Math.round(input.triage.confidence * 100)}% sure it understood the issue.`);
  if (input.plan?.autoApproveEligible === true) signals.push("The plan is small enough to approve without a person.");
  if (input.plan?.autoApproveEligible === false) signals.push("The plan needs a person to approve it.");
  if ((input.build?.rounds ?? 0) > 1) signals.push(`The build took ${input.build!.rounds} rounds to pass its checks.`);
  if (input.gate)
    signals.push(
      /^pass/i.test(input.gate.status) ? "The project's checks passed." : "The project's checks did not pass.",
    );
  if (input.verify?.result === "pass") signals.push("A separate review passed the change.");
  else if (input.verify?.result) signals.push(`The separate review returned ${input.verify.result}.`);
  const findings = input.verify?.findings?.length ?? 0;
  if (findings) signals.push(`The review left ${findings} ${findings === 1 ? "suggestion" : "suggestions"}.`);
  const shots = (input.build?.screenshots ?? []).map((s) => ({
    state: plain(String(s.state ?? "")),
    viewport: plain(String(s.viewport ?? "")),
    theme: plain(String(s.theme ?? "")),
  }));
  // A before and an after at the same viewport is the "verify this fix" pair.
  const pairs = [...new Set(shots.map((s) => s.viewport))].filter(
    (v) =>
      shots.some((s) => s.viewport === v && /before/i.test(s.state)) &&
      shots.some((s) => s.viewport === v && /after/i.test(s.state)),
  );
  return {
    risk: { level, signals },
    preview: { prUrl: input.prUrl ?? null, shots, pairs },
    cost: operator
      ? {
          totalUsd: input.stages.reduce((n, s) => n + (s.cost_usd ?? 0), 0),
          stages: input.stages.map((s) => ({
            stage: s.stage,
            agent: plain(s.agent),
            model: s.model ?? "default",
            costUsd: s.cost_usd ?? 0,
          })),
        }
      : null,
  };
}

export interface PaneDeps {
  repo: string;
  workspacesFor: (repo: string) => string;
  stagesFor: (repo: string, issue: number) => PaneInput["stages"];
  prUrlFor: (repo: string, issue: number) => string | null;
  actorOf: (req: Request) => Actor | undefined;
}

const MAX_RISKS = 100;

export function paneRoutes(deps: PaneDeps): Route[] {
  const repoOf = (url: URL) => url.searchParams.get("repo") || deps.repo;
  const artifact = (r: string, n: number, stage: "triage" | "plan" | "build" | "verify") =>
    readStageArtifacts(join(deps.workspacesFor(r), `issue-${n}`), n, stage).then((a) => a.json);
  return [
    {
      // The rail's risk badges, one level per listed issue, so the list never fetches a pane per row.
      method: "GET",
      pattern: /^\/api\/risk$/,
      label: "GET /api/risk",
      role: "viewer",
      handler: async (_req, url) => {
        const r = repoOf(url);
        if (!r) return Response.json({ error: "no repo configured or specified" }, { status: 400 });
        const issues = (url.searchParams.get("issues") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_RISKS);
        const levels = await Promise.all(
          issues.map(async (n) => [n, riskLevel({ triage: await artifact(r, n, "triage"), plan: await artifact(r, n, "plan") } as PaneInput)] as const),
        );
        return Response.json({ repo: r, levels: Object.fromEntries(levels) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/pane$/,
      label: "GET /api/issues/:n/pane",
      role: "viewer",
      handler: async (req, url, m) => {
        const r = repoOf(url);
        if (!r) return Response.json({ error: "no repo configured or specified" }, { status: 400 });
        const n = Number(m[1]);
        const [triage, plan, build, verify, gate] = await Promise.all([
          ...(["triage", "plan", "build", "verify"] as const).map((s) => artifact(r, n, s)),
          readGateEvidence(join(deps.workspacesFor(r), `issue-${n}`), n),
        ]);
        const operator = atLeast(deps.actorOf(req)?.role ?? "viewer", "operator");
        return Response.json(
          paneView(
            {
              triage,
              plan,
              build,
              verify,
              gate,
              stages: deps.stagesFor(r, n),
              prUrl: deps.prUrlFor(r, n),
            } as PaneInput,
            operator,
          ),
        );
      },
    },
  ];
}
