// Before a cloud run starts, say why it would fail. All I/O is injected; nothing calls this yet.
import type { PlannedIssue } from "../engine/import-plan";

export interface PreflightIo {
  fileExists(path: string): Promise<boolean>;
  issueDone(issue: number): Promise<boolean>;
  branchExists(branch: string): Promise<boolean>;
  readFile(path: string): Promise<string | null>;
}

export interface PreflightFacts {
  missing: string[];
  openDeps: number[];
  branchTaken: boolean;
  settings: string | null;
}

const SETTINGS_PATH = ".claude/settings.json";

// A rejected call is the failing answer, never a pass.
const answer = async <T>(ask: () => Promise<T>, failing: T): Promise<T> => {
  try {
    return await ask();
  } catch {
    return failing;
  }
};

export async function gatherFacts(plan: PlannedIssue, branch: string, io: PreflightIo): Promise<PreflightFacts> {
  const edited = plan.files.filter((f) => !f.isNew).map((f) => f.path);
  const [present, done, branchTaken, settings] = await Promise.all([
    Promise.all(edited.map((p) => answer(() => io.fileExists(p), false))),
    Promise.all(plan.meta.deps.map((d) => answer(() => io.issueDone(d), false))),
    answer(() => io.branchExists(branch), true),
    answer(() => io.readFile(SETTINGS_PATH), null),
  ]);
  return {
    missing: edited.filter((_, i) => !present[i]),
    openDeps: plan.meta.deps.filter((_, i) => !done[i]),
    branchTaken,
    settings,
  };
}

export const isWorkflowPath = (path: string): boolean => path.startsWith(".github/workflows/");

// `*` is any text and the legacy `:*` suffix is `*`; every other character is literal.
const bashRule = (rule: string): RegExp | undefined => {
  if (rule === "Bash") return /^.*$/s;
  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return undefined;
  const pattern = (m[1] ?? "").replace(/:\*$/, "*");
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "s");
};

// biome-ignore format: the mutation entry matches this statement on one line
export const deniesPush = (rule: string, branch: string): boolean => bashRule(rule)?.test(`git push origin ${branch}`) ?? false;

const denyRules = (settings: string): string[] | undefined => {
  try {
    const deny = (JSON.parse(settings) as { permissions?: { deny?: unknown } })?.permissions?.deny;
    return Array.isArray(deny) ? deny.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return undefined;
  }
};

export function preflightProblems(plan: PlannedIssue, facts: PreflightFacts, branch: string): string[] {
  const problems: string[] = [];
  for (const path of facts.missing) {
    problems.push(
      `The plan edits \`${path}\`, which the repo does not have: fix the Files list or land that file first.`,
    );
  }
  for (const dep of plan.meta.deps) {
    const blocked = facts.openDeps.includes(dep);
    if (blocked) {
      problems.push(`Dep #${dep} is not merged yet: wait for it or drop it from Deps.`);
    }
  }
  if (facts.branchTaken) {
    problems.push(`Branch \`${branch}\` already exists: close or delete it before a new run.`);
  }
  if (facts.settings !== null) {
    const deny = denyRules(facts.settings);
    if (deny === undefined) {
      problems.push(`\`${SETTINGS_PATH}\` is not valid JSON: fix it so its deny rules can be read.`);
    } else {
      for (const rule of deny.filter((r) => deniesPush(r, branch))) {
        problems.push(
          `\`${SETTINGS_PATH}\` denies \`${rule}\`, which blocks \`git push origin ${branch}\`: narrow it to force pushes only.`,
        );
      }
    }
  }
  for (const { path } of plan.files) {
    if (isWorkflowPath(path)) {
      problems.push(
        `The plan writes \`${path}\`, which the run's token cannot push: stage it under \`ci/\` and move it by hand.`,
      );
    }
  }
  return problems;
}

export async function preflight(
  plan: PlannedIssue,
  branch: string,
  io: PreflightIo,
): Promise<{ ok: boolean; problems: string[] }> {
  const problems = preflightProblems(plan, await gatherFacts(plan, branch, io), branch);
  return { ok: problems.length === 0, problems };
}
