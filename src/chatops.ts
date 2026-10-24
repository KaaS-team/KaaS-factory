// Trust rule and ChatOps parsing (plan section 2). Pure functions: no I/O, so
// watch.test.ts exercises them directly.

import type { GhComment } from "./github";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isTrusted(comment: Pick<GhComment, "authorAssociation">): boolean {
  return TRUSTED_ASSOCIATIONS.has(comment.authorAssociation);
}

// The runner posts as the operator, so its own comments are OWNER-authored.
// Every one carries a `<!-- factory:` marker; none is a human answer.
export function isHumanComment(comment: Pick<GhComment, "authorAssociation" | "body">): boolean {
  return isTrusted(comment) && !comment.body.includes("<!-- factory:");
}

export type Command =
  | { type: "approve" }
  | { type: "revise"; text: string }
  | { type: "retry" }
  | { type: "cancel" }
  | { type: "answer"; text: string };

const COMMAND_RE = /^\s*\/factory\s+(approve|revise|retry|cancel)\b\s*(.*)$/is;

// A trusted comment is either a `/factory <cmd>` line or, failing that, a
// plain-text answer to the latest open question. Untrusted comments are never
// parsed as commands or answers (prompt-injection lesson, plan section 2).
export function parseChatOps(body: string): Command {
  const match = body.match(COMMAND_RE);
  if (match) {
    const verb = match[1]!.toLowerCase();
    const rest = (match[2] ?? "").trim();
    if (verb === "approve") return { type: "approve" };
    if (verb === "retry") return { type: "retry" };
    if (verb === "cancel") return { type: "cancel" };
    return { type: "revise", text: rest };
  }
  return { type: "answer", text: body.trim() };
}

// Latest trusted comment posted after `afterIso`, or undefined if none.
export function latestTrustedCommentAfter(comments: readonly GhComment[], afterIso: string): GhComment | undefined {
  const after = Date.parse(afterIso);
  const trusted = comments.filter((c) => isHumanComment(c) && Date.parse(c.createdAt) > after);
  if (trusted.length === 0) return undefined;
  return trusted.reduce((latest, c) => (Date.parse(c.createdAt) > Date.parse(latest.createdAt) ? c : latest));
}
