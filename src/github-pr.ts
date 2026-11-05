// The REST calls behind GitHub.createPr and GitHub.mergePr: [call name, `gh api` argv].
import type { MergeSettings } from "./merge-method";
import type { CreatePrOptions } from "./ports/scm";

export function createPrCall(o: CreatePrOptions): [string, string[]] {
  const path = `repos/${o.repo}/pulls`;
  const fields = { title: o.title, body: o.body, head: o.head, base: o.base };
  const args = ["api", "-X", "POST", path];
  for (const [k, v] of Object.entries(fields)) args.push("-f", `${k}=${v}`);
  args.push("-F", `draft=${o.draft ? "true" : "false"}`);
  return [`POST ${path}`, args];
}

// sha makes GitHub refuse the merge if the PR's head moved since it was read. Never an admin merge.
export function mergeCall(repo: string, number: number, sha: string, s?: MergeSettings): [string, string[]] {
  const path = `repos/${repo}/pulls/${number}/merge`;
  const method = s?.method === "rebase" || s?.method === "merge" ? s.method : "squash";
  return [`PUT ${path}`, ["api", "-X", "PUT", path, "-f", `merge_method=${method}`, "-f", `sha=${sha}`]];
}
