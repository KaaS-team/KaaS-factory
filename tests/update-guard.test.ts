// `factory install --update` keeps a file the repo edited since the last install (issue #321).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTemplate } from "../src/install-template";

const HOOK = join(".claude", "hooks", "guard-paths.sh");
const dirs: string[] = [];
function scratch(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const d = mkdtempSync(join(tmpdir(), "factory-guard-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const manifestOf = (t: string): Record<string, string> =>
  JSON.parse(readFileSync(join(t, ".factory", "manifest.json"), "utf8")).files;

describe("update keeps edited files", () => {
  test("an edited file survives, the template lands beside it, and the line names it", () => {
    const t = scratch();
    installTemplate(t);
    const original = readFileSync(join(t, HOOK), "utf8");
    writeFileSync(join(t, HOOK), "#!/usr/bin/env bash\n# mine\n");
    const r = installTemplate(t, { update: true });
    expect(readFileSync(join(t, HOOK), "utf8")).toBe("#!/usr/bin/env bash\n# mine\n");
    expect(readFileSync(join(t, `${HOOK}.factory-new`), "utf8")).toBe(original);
    expect(r.lines).toContain(`kept (edited): ${HOOK}, wrote ${HOOK}.factory-new to reconcile`);
    expect(r.skipped).toContain(HOOK);
  });

  test("the kept file stays recorded under its old hash, so the next update still keeps it", () => {
    const t = scratch();
    installTemplate(t);
    const before = manifestOf(t)[HOOK];
    writeFileSync(join(t, HOOK), "# mine\n");
    installTemplate(t, { update: true });
    expect(manifestOf(t)[HOOK]).toBe(before);
    installTemplate(t, { update: true });
    expect(readFileSync(join(t, HOOK), "utf8")).toBe("# mine\n");
  });

  test("an untouched file is still refreshed, and a dry run writes nothing", () => {
    const t = scratch();
    installTemplate(t);
    writeFileSync(join(t, HOOK), "# mine\n");
    const dry = installTemplate(t, { update: true, dryRun: true });
    expect(dry.lines).toContain(`kept (edited): ${HOOK}, would write ${HOOK}.factory-new to reconcile`);
    expect(existsSync(join(t, `${HOOK}.factory-new`))).toBe(false);
    const other = join(t, ".claude", "hooks", "stop-artifact.sh");
    const stock = readFileSync(other, "utf8");
    const r = installTemplate(t, { update: true });
    expect(readFileSync(other, "utf8")).toBe(stock);
    expect(r.lines).not.toContain("kept (edited): .claude/hooks/stop-artifact.sh");
  });

  test("a file equal to the new template is not reported as an edit", () => {
    const t = scratch();
    installTemplate(t);
    writeFileSync(join(t, ".factory", "manifest.json"), JSON.stringify({ files: { [HOOK]: "0".repeat(64) } }));
    const r = installTemplate(t, { update: true });
    expect(r.lines.some((l) => l.startsWith("kept (edited)"))).toBe(false);
  });
});
