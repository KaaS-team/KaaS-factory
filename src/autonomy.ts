// How far the factory goes on its own, per repo: `merge.autonomy`, or the mode set from the web
// (a trusted `factory:mode` comment on the control issue, which wins over config so a person can
// pull a repo back to supervised without a commit).

import type { Risk } from "./artifacts";
import type { MergeConfig } from "./config";
import type { GhComment } from "./github";
import type { ScmPort } from "./ports/scm";
import { runnerLogin } from "./trust";

export type Autonomy = "supervised" | "semi" | "full";
export const AUTONOMY_MODES: readonly Autonomy[] = ["supervised", "semi", "full"];

// Who acts at each stage. `null` means a human must act; a risk means the factory acts by itself
// up to and including that risk. Triage, build, verify and the PR always run; review count rises
// with risk; plan approval and the merge are the two stages a tier hands over.
export interface Steering {
  readonly triage: "auto";
  readonly planApprove: Risk | null;
  readonly build: "auto";
  readonly pr: "draft" | "ready";
  readonly reviewers: (risk: Risk) => number;
  readonly merge: Risk | null;
}

export const reviewerCount = (risk: Risk) => (risk === "high" ? 2 : 1);
const reviewers = reviewerCount;

export const STEERING: Readonly<Record<Autonomy, Steering>> = {
  supervised: { triage: "auto", planApprove: null, build: "auto", pr: "draft", reviewers, merge: null },
  semi: { triage: "auto", planApprove: "low", build: "auto", pr: "ready", reviewers, merge: "low" },
  full: { triage: "auto", planApprove: "high", build: "auto", pr: "ready", reviewers, merge: "high" },
};

const ORDER: readonly Risk[] = ["low", "medium", "high"];
const within = (risk: Risk, cap: Risk | null) => cap !== null && ORDER.indexOf(risk) <= ORDER.indexOf(cap);

export const planAutoApproves = (mode: Autonomy, risk: Risk): boolean => within(risk, STEERING[mode].planApprove);
export const mergeAutoAllowed = (mode: Autonomy, risk: Risk): boolean => within(risk, STEERING[mode].merge);

export function autonomyOf(merge: Pick<MergeConfig, "policy" | "autonomy">, webMode?: Autonomy): Autonomy {
  if (webMode) return webMode;
  if (merge.autonomy) return merge.autonomy;
  return merge.policy === "auto" ? "semi" : "supervised";
}

export const CONTROL_LABEL = "factory:control";
export const modeMarker = (mode: Autonomy) => `<!-- factory:mode ${mode} -->`;
const MODE_RE = /<!-- factory:mode (supervised|semi|full) -->/;

// The latest mode the runner's own account wrote; the plane posts under that account, so a
// marker from anyone else is text, not a command.
export function modeFromComments(comments: readonly GhComment[], self: string): Autonomy | undefined {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const c = comments[i]!;
    if (c.author !== self) continue;
    const m = MODE_RE.exec(c.body);
    if (m) return m[1] as Autonomy;
  }
  return undefined;
}

// The mode set from the web, read from the tracker the plane wrote it to; none set is undefined.
export async function webMode(
  github: Pick<ScmPort, "listIssuesByLabel" | "currentLogin" | "roleOf">,
  repo: string,
): Promise<Autonomy | undefined> {
  const control = (await github.listIssuesByLabel(repo, CONTROL_LABEL))[0];
  if (!control) return undefined;
  return modeFromComments(control.comments, await runnerLogin(github));
}

// The plan edge's tier toggles: `tiered` once a mode is set (web or config), and whether that mode
// approves a plan of this risk by itself. An unrated plan reads as high.
export async function tierToggles(
  github: Pick<ScmPort, "listIssuesByLabel" | "currentLogin" | "roleOf">,
  repo: string,
  merge: Pick<MergeConfig, "policy" | "autonomy">,
  planRisk: unknown,
): Promise<{ tiered: boolean; tierApproves: boolean }> {
  const set = (await webMode(github, repo).catch(() => undefined)) ?? merge.autonomy;
  if (!set) return { tiered: false, tierApproves: false };
  const risk: Risk = planRisk === "low" || planRisk === "medium" ? planRisk : "high";
  return { tiered: true, tierApproves: planAutoApproves(set, risk) };
}
