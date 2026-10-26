// One trust rule for labels and commands: write access or higher. A comment's authorAssociation
// alone is not enough, since a read-only collaborator is a COLLABORATOR too. Roles are cached for
// ROLE_CACHE_MS per SCM so a waiting issue does not cost an API call every poll.

import { isHumanComment } from "./chatops";
import type { GhComment } from "./github";
import { type RepoRole, type ScmPort, TRUSTED_ROLES } from "./ports/scm";

type Roles = Pick<ScmPort, "roleOf">;

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

// The thread as the runner may read it: a human comment stays only when its author has write access or
// higher, so a read-only collaborator's words never become a command, an answer or earlier revise
// feedback, and cannot hide a maintainer's reply by posting after it. Runner comments always stay.
export async function writersOnly<C extends GhComment>(github: Roles, repo: string, comments: readonly C[]) {
  const keep = await Promise.all(comments.map((c) => !isHumanComment(c) || isWriter(github, repo, c)));
  return comments.filter((_, i) => keep[i]);
}
