// Commit message bodies for the factory's own commits: a why and a closing line for build
// commits, and a plain-words claim message that keeps a machine marker but no runner id in its title.

export const CLAIM_MARKER = "Factory-Claim";

// The why is the plan's goal, kept to a few sentences, followed by the closing line.
export function withWhyAndCloses(subject: string, why: string, ref: string, extra = ""): string {
  const body = why.trim() || "Built from the approved plan.";
  return `${subject}\n\n${body}${extra ? `\n\n${extra}` : ""}\n\nCloses ${ref}`;
}

// The runner id stays in the body for tracing; the title says what happened in plain words.
export function claimCommitMessage(issue: number, runnerId: string): string {
  return [
    `chore(factory): claim issue #${issue} for the factory`,
    "",
    `The factory claimed issue #${issue} so only one runner builds it. The build commits follow on this branch.`,
    "",
    `${CLAIM_MARKER}: #${issue} runner ${runnerId}`,
  ].join("\n");
}
