// Intent to spec to tickets: two stages, each a different agent through the same Executor every
// factory stage runs on, each answer held by a deterministic check before the next stage sees it.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScmPort } from "../ports/scm";
import { runSpecStage, specPath, type Spec, type StageAgent } from "./spec";
import { fileTickets, runTicketsStage, type FiledTicket } from "./tickets";

export interface IntentRun {
  readonly spec: StageAgent;
  readonly tickets: StageAgent;
  readonly scm: Pick<ScmPort, "createIssue">;
  readonly repo: string;
  readonly labels: string[];
}

export type IntentResult =
  | { readonly ok: true; readonly spec: Spec; readonly specFile: string; readonly filed: FiledTicket[] }
  | { readonly ok: false; readonly stage: "spec" | "tickets"; readonly problems: readonly string[] };

// One agent grading its own spec as tickets would miss what it missed twice, so the roles differ.
export async function intentToTickets(run: IntentRun, intent: string): Promise<IntentResult> {
  if (run.spec.agent === run.tickets.agent)
    return {
      ok: false,
      stage: "tickets",
      problems: [`the spec and tickets stages both name agent "${run.spec.agent}"`],
    };
  const spec = await runSpecStage(run.spec, intent);
  if (!spec.ok) return { ok: false, stage: "spec", problems: spec.problems };
  const tickets = await runTicketsStage(run.tickets, spec.value);
  if (!tickets.ok) return { ok: false, stage: "tickets", problems: tickets.problems };
  // The spec is written where check-acceptance.py looks for it, so each ticket's holdouts have a spec to name.
  const specFile = join(run.spec.cwd, specPath(spec.value));
  mkdirSync(dirname(specFile), { recursive: true });
  writeFileSync(specFile, spec.value.markdown.endsWith("\n") ? spec.value.markdown : `${spec.value.markdown}\n`);
  const filed = await fileTickets(run.scm, run.repo, spec.value, tickets.value, run.labels);
  return { ok: true, spec: spec.value, specFile, filed };
}
