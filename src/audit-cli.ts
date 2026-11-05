// `factory audit [--repo-dir <path>] [--file-issues] [--json]`: score the repo, print one report, and
// optionally file each finding as an issue. src/cli.ts dispatches here.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  audit,
  type AuditChange,
  type AuditInput,
  type AuditReport,
  findingMarker,
  issueFor,
  renderReport,
} from "./audit";
import { successJson } from "./cli-output";
import type { CliContext } from "./cli-runtime";
import { loadConfig } from "./config";
import type { ScmPort } from "./github";
import { LABEL } from "./labels";
import { makeScm } from "./scm";

const MARK = "\u0001";

export function parseChanges(log: string): AuditChange[] {
  return log
    .split(MARK)
    .filter((b) => b.trim())
    .flatMap((block) => {
      const [subject = "", ...files] = block.split("\n").filter(Boolean);
      const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
      return pr ? [{ pr, subject, files }] : [];
    });
}

function git(dir: string, args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

export function readAuditInput(dir: string, commits = 200): AuditInput {
  const files = git(dir, ["ls-files"]).split("\n").filter(Boolean);
  const log = git(dir, ["log", "--first-parent", `-n${commits}`, "--no-renames", "--name-only", `--format=${MARK}%s`]);
  const read = (p: string) => {
    try {
      return readFileSync(join(dir, p), "utf8");
    } catch {
      return undefined;
    }
  };
  return { files, read, changes: parseChanges(log) };
}

// One issue per finding, never a second while one is open: the marker in the body is the key.
export async function fileFindings(github: ScmPort, repo: string, report: AuditReport) {
  const open = await github.listOpenIssues(repo);
  const filed: string[] = [];
  const skipped: string[] = [];
  for (const f of report.findings) {
    if (open.some((i) => i.body.includes(findingMarker(f.id)))) {
      skipped.push(f.id);
      continue;
    }
    const { title, body } = issueFor(f);
    await github.createIssue(repo, title, body, [LABEL.monitor]);
    filed.push(f.id);
  }
  return { filed, skipped };
}

export async function cmdAudit(cli: CliContext): Promise<void> {
  const dir = resolve(cli.flag("repo-dir") ?? ".");
  const report = audit(readAuditInput(dir));
  const filing = cli.has("file-issues")
    ? await (async () => {
        const config = await loadConfig(dir);
        return fileFindings(makeScm(config), config.repo, report);
      })()
    : undefined;
  if (cli.has("json")) return void console.log(successJson({ ...report, ...(filing ? { filing } : {}) }));
  process.stdout.write(renderReport(report));
  if (filing) console.log(`filed ${filing.filed.length}, skipped ${filing.skipped.length} (already open)`);
}
