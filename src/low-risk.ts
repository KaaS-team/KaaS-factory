// The low-risk class: the changes the factory merges with no human. Docs, tests and copy only, under
// merge.maxLines, every check and acceptance proof green. The class is read from the diff alone,
// never from a label, an issue type or the agent's own rating, so nobody widens it by tagging a PR.

import type { AcceptanceVerdict } from "./acceptance";
import type { GitHub } from "./github";
import { runDir } from "./artifacts";
import {
  attemptMerge,
  decideMerge,
  type ChangedFile,
  type DecideMergeInput,
  type MergeDecision,
  type MergeRefusal,
} from "./merge-policy";
import { HIGH_RISK } from "./risk";

// The default class (merge.lowRiskPaths): docs, tests and copy.
export const LOW_RISK_PATHS: readonly string[] = [
  "docs/**",
  "**/*.md",
  "**/*.mdx",
  "**/*.txt",
  "test/**",
  "tests/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "content/**",
  "copy/**",
  "locales/**",
  "**/locales/**",
  "**/i18n/**",
];

// Never in the class, whatever merge.lowRiskPaths says: migrations and schema, dependencies and CI
// (risk.ts's HIGH_RISK), then auth, infra and secrets. A test or doc under one of these is not low risk.
export const NEVER_LOW_RISK: readonly RegExp[] = [
  ...HIGH_RISK,
  /(^|\/)(auth|authn|authz|login|session|sessions|permissions?|rbac|oauth|sso|security)(\/|\.|$)/i,
  /^\.(github|gitlab|circleci|buildkite)\//,
  /(^|\/)(\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml|CODEOWNERS)$/,
  /(^|\/)(infra|infrastructure|deploy|deployment|terraform|k8s|kubernetes|helm|ansible|ops)\//,
  /\.(tf|tfvars|hcl)$/,
  /(^|\/)(docker-compose[^/]*\.ya?ml|compose\.ya?ml|Makefile|Procfile|fly\.toml|vercel\.json|netlify\.toml)$/,
  /(^|\/)\.env(\.|$)/,
];

// Every changed file inside the class and outside NEVER_LOW_RISK. Size, modes and binaries are
// autoEligible's (merge-policy.ts), so the class adds only what a path says.
export function lowRiskClassRefusals(files: readonly ChangedFile[], classPaths?: readonly string[]): MergeRefusal[] {
  const globs = (classPaths?.length ? classPaths : LOW_RISK_PATHS).map((p) => new Bun.Glob(p));
  const never = files.filter((f) => NEVER_LOW_RISK.some((re) => re.test(f.path))).map((f) => f.path);
  const outside = files.filter((f) => !globs.some((g) => g.match(f.path))).map((f) => f.path);
  const out: MergeRefusal[] = [];
  if (never.length)
    out.push({
      reason: "outside-low-risk-class",
      detail: `migration, auth, dependency, CI or infra: ${never.join(", ")}`,
    });
  if (outside.length)
    out.push({ reason: "outside-low-risk-class", detail: `not docs, tests or copy: ${outside.join(", ")}` });
  return out;
}

// Every acceptance criterion verify recorded must have passed. No acceptance.json means the repo has
// no acceptance script, so CI's checks are the proofs; a verdict with no criteria or with errors is red.
export function acceptanceRefusals(verdict: AcceptanceVerdict | null | undefined): MergeRefusal[] {
  if (verdict == null) return [];
  const failed = verdict.acs.filter((r) => !r.ok).map((r) => `${r.spec} ${r.ac}`);
  const out: MergeRefusal[] = [];
  if (!verdict.acs.length) out.push({ reason: "acceptance-red", detail: "the acceptance run found no criteria" });
  if (failed.length) out.push({ reason: "acceptance-red", detail: `not proven: ${failed.join(", ")}` });
  if (verdict.errors.length)
    out.push({ reason: "acceptance-red", detail: `acceptance errors: ${verdict.errors.join("; ")}` });
  return out;
}

export async function readAcceptance(worktree: string, issue: number): Promise<AcceptanceVerdict | null> {
  const f = Bun.file(`${worktree}/${runDir(issue)}/acceptance.json`);
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as AcceptanceVerdict;
  } catch {
    return { base: null, acs: [], errors: ["acceptance.json is not valid JSON"] };
  }
}

// The watcher's merge decision with the acceptance verdict verify left in the run dir.
export async function decideMergeAt(worktree: string, issue: number, input: DecideMergeInput): Promise<MergeDecision> {
  return decideMerge({ ...input, acceptance: await readAcceptance(worktree, issue) });
}

// The merge-serial seam: the one place a policy merge with no tier lands. It merges the decided head
// directly today; goal merge-serial routes it through the merge queue, so only this body changes.
export async function landPolicyMerge(
  github: Pick<GitHub, "mergePr">,
  repo: string,
  pr: number,
  decision: MergeDecision,
): Promise<boolean> {
  return attemptMerge(github, repo, pr, decision);
}
