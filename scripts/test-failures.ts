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

export function summarize(xml: string, exitCode?: number | null): string {
  const runs = parseJunit(xml);
  if (runs.size === 0) return "no testcases found in the junit report";
  const failed = [...runs].filter(([, r]) => r.fail > 0).map(([key]) => key);
  if (failed.length === 0) {
    if (exitCode)
      return `test step exited non-zero (exit code ${exitCode}) and the report shows no failing case (${runs.size} ran)`;
    return `no failing tests (${runs.size} ran)`;
  }
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

export function report(path: string, stepSummary?: string, exitCode?: number | null): string {
  const missing = !existsSync(path) || readFileSync(path, "utf8").trim() === "";
  const text = missing
    ? `no junit report at ${path}; the test step ended before writing one`
    : summarize(readFileSync(path, "utf8"), exitCode);
  if (stepSummary) appendFileSync(stepSummary, `### Failing tests\n\n\`\`\`\n${text}\n\`\`\`\n`);
  return text;
}

function headerFiles(log: string): string[] {
  const out: string[] = [];
  for (const line of log.split("\n")) {
    if (line.endsWith(".test.ts:") && line.startsWith("tests/")) out.push(line.slice(0, -1));
  }
  return out;
}

function junitTestFiles(xml: string): string[] {
  const files = new Set<string>();
  for (const m of xml.matchAll(/<testcase\b([^>]*)/g)) {
    const v = /\bfile="([^"]*)"/.exec(m[1]!)?.[1];
    if (v !== undefined) files.add(unXml(v));
  }
  return [...files];
}

export function unfinished(log: string, junitFiles: readonly string[]): string[] {
  const have = new Set(junitFiles);
  return headerFiles(log).filter((f) => !have.has(f));
}

// bun prints "# Unhandled error between tests" for an error outside any test; the junit file has no case for it.
export function unhandledErrors(log: string): { file: string; message: string }[] {
  const out: { file: string; message: string }[] = [];
  let file = "";
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\S.*\.test\.ts:$/.test(line)) file = line.slice(0, -1);
    if (line.trim() !== "# Unhandled error between tests") continue;
    const msg = lines.slice(i + 1).find((l) => /^error: /.test(l)) ?? "error: (no message)";
    out.push({ file: file || "(unknown file)", message: msg.trim() });
  }
  return out;
}

export function reportWithLog(
  junitPath: string,
  logPath: string | undefined,
  stepSummary?: string,
  exitCode?: number | null,
): string {
  if (!logPath) return report(junitPath, stepSummary, exitCode);
  const log0 = readFileSync(logPath, "utf8");
  const unhandled = unhandledErrors(log0);
  let text = report(junitPath, undefined, exitCode);
  if (unhandled.length > 0 && text.startsWith("no failing tests")) text = "";
  const log = readFileSync(logPath, "utf8");
  const missing = !existsSync(junitPath) || readFileSync(junitPath, "utf8").trim() === "";
  let extra = "";
  if (missing) {
    const started = headerFiles(log);
    const last = started[started.length - 1];
    if (last !== undefined) extra = `\nlast test file started: ${last}`;
  } else {
    const unfin = unfinished(log, junitTestFiles(readFileSync(junitPath, "utf8")));
    const lines: string[] = [];
    for (const f of unfin.slice(0, CAP)) lines.push(`unfinished: ${f}`);
    if (unfin.length > CAP) lines.push(`and ${unfin.length - CAP} more`);
    if (lines.length > 0) extra = `\n${lines.join("\n")}`;
    const abort = /\[Makefile:\d+: test\] (Error \d+)/.exec(log)?.[1];
    const last = headerFiles(log).at(-1);
    if (abort && last && !text.includes("FAILED ")) {
      extra += `\ntest step exited non-zero (${abort}) and no test failed; last test file started: ${last}`;
    }
  }
  const named = unhandled.map((u) => `unhandled error between tests in ${u.file}: ${u.message}`).join("\n");
  const out = [text, named].filter(Boolean).join("\n") + extra;
  if (stepSummary) appendFileSync(stepSummary, `### Failing tests\n\n\`\`\`\n${out}\n\`\`\`\n`);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let logPath: string | undefined;
  let exitCode: number | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--log" && args[i + 1]) {
      logPath = args[++i];
    } else if (args[i] === "--exit" && args[i + 1]) {
      exitCode = Number(args[++i]);
    } else {
      rest.push(args[i]!);
    }
  }
  console.log(reportWithLog(rest[0] ?? "reports/junit.xml", logPath, process.env.GITHUB_STEP_SUMMARY, exitCode));
}
