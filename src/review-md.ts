// A root REVIEW.md holds what a reviewer of this repo checks. The context pack folds it into the
// conventions section, so every stage that reads conventions reads the review rules too.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REVIEW_MD_PATH = "REVIEW.md";

export function reviewMdSection(cwd: string): { label: string; body: string } | undefined {
  const path = join(cwd, REVIEW_MD_PATH);
  if (!existsSync(path)) return undefined;
  const body = readFileSync(path, "utf8").trim();
  return body ? { label: REVIEW_MD_PATH, body } : undefined;
}
