// A PR body follows one of two documented shapes: the template's sections (a human PR) or the factory's own
// (What changed, Acceptance and a receipt line). Nothing else merges, and no session link ever appears in one.
import { readFileSync } from "node:fs";

const TEMPLATE = ".github/pull_request_template.md";

const headings = (text: string): string[] => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
const sections = (body: string): Map<string, string> => {
  const out = new Map<string, string>();
  const parts = body.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const name = (nl < 0 ? part : part.slice(0, nl)).trim();
    const text = nl < 0 ? "" : part.slice(nl + 1);
    out.set(name, text.replace(/<!--[\s\S]*?-->/g, "").trim());
  }
  return out;
};

export function problems(body: string, template: string): string[] {
  const found = sections(body);
  const out: string[] = [];
  if (/claude\.ai\/code|Claude-Session:/.test(body)) out.push("the body links a Claude session");
  const factoryShape = found.has("What changed") && found.has("Acceptance") && /run-details comment/.test(body);
  if (factoryShape) return out;
  for (const name of headings(template)) {
    const text = found.get(name);
    if (text === undefined) out.push(`missing section "${name}"`);
    else if (!text.replace(/^Closes #?\s*$/m, "").trim()) out.push(`section "${name}" is empty`);
  }
  const verdict = (found.get("Verify verdict") ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
  if (/^(pending|tbd|todo|na)(\s|$)/.test(verdict) || /^(pass|passed|ok|none)$/.test(verdict)) {
    out.push('section "Verify verdict" is a placeholder');
  }
  const gate = found.get("Gate evidence");
  if (gate?.trim() && !/```|\d/.test(gate)) out.push('section "Gate evidence" has no output');
  return out;
}

if (import.meta.main) {
  // `--file <path>` lints a body on disk before the PR exists; CI passes it in PR_BODY.
  const at = process.argv.indexOf("--file");
  const path = at < 0 ? undefined : process.argv[at + 1];
  if (at >= 0 && !path) {
    console.error("check-pr-body: --file needs a path");
    process.exit(1);
  }
  const body = path ? readFileSync(path, "utf8") : (process.env.PR_BODY ?? "");
  const found = problems(body, readFileSync(TEMPLATE, "utf8"));
  if (found.length) {
    console.error(`check-pr-body: the PR body does not follow ${TEMPLATE}\n- ${found.join("\n- ")}`);
    process.exit(1);
  }
  console.log("check-pr-body: ok");
}
