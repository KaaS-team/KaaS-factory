// Every Markdown file in the repo has balanced fences and no dead local links.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkMarkdown } from "../src/docs-links";

test("every *.md in the repo passes the blueprint Markdown checks", () => {
  const errors: string[] = [];
  checkMarkdown(errors, join(import.meta.dir, ".."));
  expect(errors).toEqual([]);
});
