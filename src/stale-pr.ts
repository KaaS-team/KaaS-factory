// A nudge for a factory pull request nobody has touched in days: it lands in the inbox, so it
// also reaches the phone as "needs you". Learning PRs have their own inbox item and are left out.
import { learningPrItems, type InboxItem } from "./inbox";
import type { GhPr } from "./ports/scm";

export const STALE_PR_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function stalePrItems(prs: readonly GhPr[], now = Date.now(), days = STALE_PR_DAYS): InboxItem[] {
  return prs
    .filter((pr) => pr.state.toUpperCase() === "OPEN" && !pr.isDraft && pr.updatedAt)
    .filter((pr) => pr.headRefName.startsWith("factory/") && !pr.headRefName.startsWith("factory/learning-"))
    .filter((pr) => now - Date.parse(pr.updatedAt!) >= days * DAY_MS)
    .map((pr) => {
      const quiet = Math.floor((now - Date.parse(pr.updatedAt!)) / DAY_MS);
      return {
        id: `stale-pr-${pr.number}`,
        kind: "stale-pr" as const,
        issue: pr.closingIssuesReferences?.[0]?.number ?? pr.number,
        title: `Pull request #${pr.number}`,
        label: "",
        waitingSince: pr.updatedAt,
        ask: `No activity for ${quiet} days: review it, merge it or close it. ${pr.url}`,
        actions: [] as const,
      };
    });
}

// Every inbox item that comes from a pull request rather than an issue label.
export const prItems = (prs: readonly GhPr[], now = Date.now()): InboxItem[] => [
  ...learningPrItems(prs),
  ...stalePrItems(prs, now),
];
