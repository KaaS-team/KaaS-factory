// Who may open an implementation pull request. Bugs and ideas go through issues; a PR from anyone
// else is closed with a pointer to CONTRIBUTING.md. Pure, so a workflow or script can call it.

export const MAINTAINER_ASSOCIATIONS: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];
export const APPROVED_FILE = ".github/approved-contributors.json";

export interface PrAuthor {
  readonly login: string;
  readonly association: string;
}

export function parseApproved(text: string): string[] {
  const data: unknown = JSON.parse(text);
  const logins = (data as { logins?: unknown } | null)?.logins;
  if (!Array.isArray(logins) || !logins.every((l) => typeof l === "string")) {
    throw new Error(`${APPROVED_FILE}: expected {"logins": [string, ...]}`);
  }
  return logins.map((l: string) => l.toLowerCase());
}

export function decidePr(author: PrAuthor, approved: readonly string[]): "keep" | "close" {
  if (MAINTAINER_ASSOCIATIONS.includes(author.association)) return "keep";
  return approved.includes(author.login.toLowerCase()) ? "keep" : "close";
}

export const closePointer = (): string =>
  "Thanks for the interest. Implementation pull requests here come from maintainers and an approved list, " +
  "so this one is closed. Open an issue in the planned format instead: see CONTRIBUTING.md.";
