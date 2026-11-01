// Failing-test summary for CI: reads the junit file `make test` writes and names each failing test.
// It only reports; the test step itself fails the job, so the exit code is always 0.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseJunit } from "./flake-report";

export const CAP = 20;

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const unXml = (s: string): string =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+);/g, (_, e: string) =>
    e.startsWith("#") ? String.fromCharCode(Number(e.slice(1))) : (ENTITIES[e] as string),
  );

// First message line per failing testcase, keyed like parseJunit: `<file>::<name>`.
function messages(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<testcase\b([^>]*[^/>])>([\s\S]*?)<\/testcase>/g)) {
    const attr = (src: string, name: string): string | undefined => {
      const v = new RegExp(`\\b${name}="([^"]*)"`).exec(src)?.[1];
      return v === undefined ? undefined : unXml(v);
    };
    const failure = /<(?:failure|error)\b([^>]*)/.exec(m[2]!);
    if (!failure) continue;
    const text = attr(failure[1]!, "message") ?? attr(failure[1]!, "type") ?? "";
    out.set(`${attr(m[1]!, "file") ?? ""}::${attr(m[1]!, "name") ?? ""}`, text.split("\n")[0]!.trim());
  }
  return out;
}

export function summarize(xml: string): string {
  const runs = parseJunit(xml);
  if (runs.size === 0) return "no testcases found in the junit report";
  const failed = [...runs].filter(([, r]) => r.fail > 0).map(([key]) => key);
  if (failed.length === 0) return `no failing tests (${runs.size} ran)`;
  const msgs = messages(xml);
  const lines: string[] = [];
  for (const key of failed.slice(0, CAP)) {
    const [file, name] = key.split("::") as [string, string];
    lines.push(`FAILED ${file} > ${name}`);
    const msg = msgs.get(key);
    if (msg) lines.push(`  ${msg}`);
  }
  if (failed.length > CAP) lines.push(`and ${failed.length - CAP} more`);
  return lines.join("\n");
}

export function report(path: string, stepSummary?: string): string {
  const missing = !existsSync(path) || readFileSync(path, "utf8").trim() === "";
  const text = missing
    ? `no junit report at ${path}; the test step ended before writing one`
    : summarize(readFileSync(path, "utf8"));
  if (stepSummary) appendFileSync(stepSummary, `### Failing tests\n\n\`\`\`\n${text}\n\`\`\`\n`);
  return text;
}

if (import.meta.main) {
  console.log(report(process.argv[2] ?? "reports/junit.xml", process.env.GITHUB_STEP_SUMMARY));
}
