// Lines a change adds to a workflow must pin each action to a full commit SHA and must not put pull request
// text into a run step. Only added lines are read, so moving tags already on the base never fail the check.
import { spawnSync } from "node:child_process";

export interface AddedLine {
  file: string;
  line: string;
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const USES = /\buses:\s*["']?([^\s@"'#]+)@([^\s"'#]*)/;
const HEX = /^[0-9a-fA-F]+$/;
const RUN = /^\s*(?:-\s+)?run:/;
const INJECTION = /\$\{\{[^}]*github\.event\.pull_request\.(?:title|body|head\.ref)[^}]*\}\}/;

export function addedWorkflowLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.startsWith("+++ b/") ? raw.slice(6) : "";
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git ")) continue;
    if (raw.startsWith("+") && WORKFLOW.test(file)) out.push({ file, line: raw.slice(1) });
  }
  return out;
}

export function pinViolations(lines: AddedLine[]): string[] {
  const out: string[] = [];
  for (const { file, line } of lines) {
    const m = USES.exec(line);
    if (m) {
      const name = m[1] ?? "";
      const ref = m[2] ?? "";
      const exempt = name.startsWith("./") || name.startsWith("docker://");
      if (!exempt && (ref.length !== 40 || !HEX.test(ref)))
        out.push(`${file}: action not pinned to a 40 character commit SHA: ${line.trim()}`);
    }
    if (RUN.test(line) && INJECTION.test(line))
      out.push(`${file}: pull request text used inside a run step: ${line.trim()}`);
  }
  return out;
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: bun scripts/check-action-pins.ts <base-ref>");
    process.exit(2);
  }
  const r = spawnSync("git", ["diff", `${base}...HEAD`, "--", ".github/workflows"], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(2);
  }
  const found = pinViolations(addedWorkflowLines(r.stdout));
  for (const v of found) console.log(v);
  process.exit(found.length > 0 ? 1 : 0);
}
