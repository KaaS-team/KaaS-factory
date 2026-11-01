// Commit message bodies for the factory's own commits: a why and a closing line for build
// commits, and a plain-words claim message that keeps a machine marker but no runner id in its title.

export const CLAIM_MARKER = "Factory-Claim";

export const WHY_SENTENCES = 3;

// The first sentences of a text, at most `max`, so a long goal never fills a commit body.
export function capSentences(text: string, max = WHY_SENTENCES): string {
  const flat = text.trim().replace(/\s+/g, " ");
  const sentences = flat.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [flat];
  return sentences.slice(0, max).join("").trim();
}

// The first paragraph under a "Problem" heading of a markdown text, if there is one.
export function problemParagraph(markdown: string | undefined): string | undefined {
  const m = /^#{1,6}\s*Problem\s*\n+([\s\S]*?)(?:\n\s*\n|\n#{1,6}\s|$)/im.exec(markdown ?? "");
  const text = m?.[1]?.trim();
  return text ? text : undefined;
}

// The why: the Problem paragraph when present, else the goal, capped at three sentences.
export function whyOf(goal: string, problemText?: string): string {
  return capSentences(problemParagraph(problemText) ?? goal);
}

// Only a branch's last commit closes the issue; the commits before it say Refs.
export function withWhyAndCloses(
  subject: string,
  why: string,
  ref: string,
  extra = "",
  keyword: "Closes" | "Refs" = "Closes",
): string {
  const body = capSentences(why) || "Built from the approved plan.";
  return `${subject}\n\n${body}${extra ? `\n\n${extra}` : ""}\n\n${keyword} ${ref}`;
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
