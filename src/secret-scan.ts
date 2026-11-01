// Finds secrets in text the runner is about to push or post. The built-in rules
// always run and need no binary. When the env var FACTORY_GITLEAKS names an
// executable that exists, it also runs on the text via stdin and its findings
// are merged in. Without that variable, gitleaks does not run.
// Findings carry the rule and the line, never the matched value.

import { existsSync } from "node:fs";

export interface SecretFinding {
  readonly rule: string;
  readonly line: number;
}

const RULES: ReadonlyArray<{ rule: string; re: RegExp }> = [
  { rule: "aws-access-key-id", re: /AKIA[A-Z0-9]{16}/g },
  { rule: "github-token", re: /(?:gh[pos]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { rule: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { rule: "slack-token", re: /xox[bpas]-[A-Za-z0-9-]{10,}/g },
  { rule: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

export function scanText(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  text.split("\n").forEach((line, i) => {
    for (const { rule, re } of RULES) {
      re.lastIndex = 0;
      if (re.test(line)) found.push({ rule, line: i + 1 });
    }
  });
  const bin = process.env.FACTORY_GITLEAKS;
  if (bin && existsSync(bin)) found.push(...gitleaks(bin, text));
  return found;
}

function gitleaks(bin: string, text: string): SecretFinding[] {
  const proc = Bun.spawnSync(
    [bin, "stdin", "--report-format", "json", "--report-path", "/dev/stdout", "--no-banner", "--log-level", "error"],
    { stdin: new TextEncoder().encode(text), stdout: "pipe", stderr: "pipe" },
  );
  try {
    const rows = JSON.parse(proc.stdout.toString() || "[]") as Array<{ RuleID?: string; StartLine?: number }>;
    return rows.map((r) => ({ rule: `gitleaks:${r.RuleID ?? "unknown"}`, line: r.StartLine ?? 1 }));
  } catch {
    return [];
  }
}

export function redact(text: string): string {
  let out = text;
  for (const { re } of RULES) out = out.replace(re, "[REDACTED]");
  return out;
}

export function describeFindings(findings: readonly SecretFinding[]): string {
  return `secret scan: ${findings.map((f) => `${f.rule} at line ${f.line}`).join(", ")}`;
}
