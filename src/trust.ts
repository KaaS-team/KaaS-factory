// One trust rule for labels and commands: write access or higher. A comment's authorAssociation
// alone is not enough, since a read-only collaborator is a COLLABORATOR too. Roles are cached for
// ROLE_CACHE_MS per SCM so a waiting issue does not cost an API call every poll.

import type { GhComment } from "./github";
import { type RepoRole, type ScmPort, TRUSTED_ROLES } from "./ports/scm";

type Roles = Pick<ScmPort, "roleOf">;
type Scm = Pick<ScmPort, "roleOf" | "currentLogin">;

export const ROLE_CACHE_MS = 5 * 60_000;
const roleCache = new WeakMap<object, Map<string, { role: RepoRole; at: number }>>();

export async function cachedRole(github: Roles, repo: string, login: string): Promise<RepoRole> {
  const cache = roleCache.get(github) ?? new Map();
  roleCache.set(github, cache);
  const key = `${repo}:${login}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ROLE_CACHE_MS) return hit.role;
  const role = await github.roleOf(repo, login);
  cache.set(key, { role, at: Date.now() });
  return role;
}

export async function isWriter(github: Roles, repo: string, comment: Pick<GhComment, "author">): Promise<boolean> {
  return TRUSTED_ROLES.includes(await cachedRole(github, repo, comment.author));
}

// The runner's own login, so its marker comments stay even on a tracker that gives it no repo role.
// A failed lookup keeps nobody by login; the writer check below still applies.
const selfLogin = new WeakMap<object, Promise<string>>();
export const runnerLogin = (github: Scm) => {
  const hit = selfLogin.get(github) ?? github.currentLogin().catch(() => "");
  selfLogin.set(github, hit);
  return hit;
};

// The thread as the runner may read it: a comment stays only when the runner or someone with write
// access or higher wrote it, whatever its body says. So a read-only collaborator's words never become a
// command, an answer or revise feedback, and nobody else's text can pose as a runner marker.
export async function writersOnly<C extends GhComment>(github: Scm, repo: string, comments: readonly C[]) {
  const self = await runnerLogin(github);
  const keep = await Promise.all(comments.map((c) => (self !== "" && c.author === self) || isWriter(github, repo, c)));
  return comments.filter((_, i) => keep[i]);
}
