// Ported from owainlewis/blueprint@54c952b scripts/tests/test_check_repo.py:13-68 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: unittest becomes bun:test; the skill-frontmatter cases are not ported.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkMarkdown } from "../../../src/docs-links";

function check(markdown: string, files: [string, string][] = []): string[] {
  const root = mkdtempSync(join(tmpdir(), "docs-links-"));
  writeFileSync(join(root, "README.md"), markdown);
  for (const [name, content] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  const errors: string[] = [];
  checkMarkdown(errors, root);
  return errors;
}

test("a missing reference-style link is reported", () => {
  expect(check("Read the [guide][details].\n\n[details]: missing.md\n").some((e) => e.includes("missing.md"))).toBe(
    true,
  );
});

test("a missing reference definition is reported", () => {
  expect(check("Read the [guide][details].\n").some((e) => e.includes("Missing reference definition"))).toBe(true);
});

test("an indented backtick fence must close", () => {
  expect(check("   ```python\nprint('hello')\n").some((e) => e.includes("Unbalanced fenced code block"))).toBe(true);
});

test("a tilde fence must close", () => {
  expect(check("~~~text\nhello\n").some((e) => e.includes("Unbalanced fenced code block"))).toBe(true);
});

test("a matching longer fence closes", () => {
  expect(check("~~~text\nhello\n~~~~\n")).toEqual([]);
});

test("an inline-code link is ignored", () => {
  expect(check("Example: `[guide](missing.md)`\n")).toEqual([]);
});

test("a fenced-code link is ignored", () => {
  expect(check("```markdown\n[guide](missing.md)\n```\n")).toEqual([]);
});

test("an angle-bracket link preserves spaces", () => {
  expect(check("Read the [guide](<docs/my guide.md>).\n", [["docs/my guide.md", "fixture\n"]])).toEqual([]);
});

test("ignored cache markdown is not checked", () => {
  expect(check("# Readme\n", [[".cache/generated.md", "[missing](nope.md)\n"]])).toEqual([]);
});
