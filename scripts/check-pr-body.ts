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
  return out;
}

if (import.meta.main) {
  const body = process.env.PR_BODY ?? "";
  const found = problems(body, readFileSync(TEMPLATE, "utf8"));
  if (found.length) {
    console.error(`check-pr-body: the PR body does not follow ${TEMPLATE}\n- ${found.join("\n- ")}`);
    process.exit(1);
  }
  console.log("check-pr-body: ok");
}
