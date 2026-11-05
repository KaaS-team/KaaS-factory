// Screens what a run plans to write (#638) before the executor applies it: the comments and titles it
// would post and the diff it would push. A hold names each finding by check and place, never by the text
// that tripped it, so the held content is not repeated on the thread. The secret scan in
// src/secret-scan.ts still guards every post; this adds the checks it cannot make.

import type { CreatePrOptions, ScmPort } from "./ports/scm";
import { scanText } from "./secret-scan";

export interface Planned {
  readonly comments?: readonly string[];
  readonly titles?: readonly string[];
  readonly diff?: string;
}
export type Check = "secret" | "agent-instruction" | "network-call" | "install-script" | "link";
export interface Finding {
  readonly check: Check;
  readonly where: string;
  readonly detail: string;
}
export type Screen = { readonly verdict: "pass" } | { readonly verdict: "hold"; readonly findings: readonly Finding[] };

// Hosts a comment or title may link to. A workflow adds its own with `allowed_hosts:`.
export const DEFAULT_HOSTS: readonly string[] = ["github.com", "githubusercontent.com"];

const INSTRUCTIONS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "tells an agent to ignore its instructions",
    /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|above|earlier|your|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules)\b/i,
  ],
  ["gives an agent new instructions", /\b(new|updated|real) (system )?instructions?\s*:/i],
  [
    "asks an agent for its prompt",
    /\b(reveal|print|show|repeat|leak)\b[^.\n]{0,30}\b(system|hidden|initial) (prompt|instructions?|message)\b/i,
  ],
  [
    "addresses an agent directly",
    /\b(ai|llm|coding) (agent|assistant|model)s?\b[^.\n]{0,12}\b(must|should|need to|please|do not|don't)\b/i,
  ],
  [
    "asks an agent to keep it from people",
    /\bdo not (tell|inform|mention|alert|notify)\b[^.\n]{0,40}\b(user|human|maintainer|reviewer|owner)s?\b/i,
  ],
  ["forges a role marker", /<\/?(system|assistant|instructions?)>|^\s*(system|assistant)\s*:/im],
];

// Files where a new network call or package install is a script, not application code.
const SCRIPT_FILE =
  /\.(sh|bash|zsh|ps1|mk)$|(^|\/)(Makefile|Dockerfile[\w.-]*|setup\.py)$|(^|\/)\.github\/workflows\/|(^|\/)package\.json$/;
const NETWORK = /\b(curl|wget|nc|ncat|telnet|scp|sftp)\s+\S|\bInvoke-WebRequest\b/;
const INSTALL = /\b(npm|pnpm|yarn|bun|pip3?|gem|cargo|apt(-get)?|brew)\s+(install|add|i)\b/;
const PIPE_TO_SHELL = /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/;
const LIFECYCLE = /"(preinstall|install|postinstall|prepare|prepublish(Only)?)"\s*:/;

function addedByFile(diff: string): Array<{ file: string; lines: string[] }> {
  const out: Array<{ file: string; lines: string[] }> = [];
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) out.push({ file: head[2]!, lines: [] });
    else if (line.startsWith("+") && !line.startsWith("+++")) out.at(-1)?.lines.push(line.slice(1));
  }
  return out;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
const allowed = (host: string, hosts: readonly string[]): boolean =>
  hosts.some((h) => host === h || host.endsWith(`.${h.toLowerCase()}`));

export function screenWrites(planned: Planned, hosts: readonly string[] = DEFAULT_HOSTS): Screen {
  const findings: Finding[] = [];
  const texts = [
    ...(planned.titles ?? []).map((t, i) => [`title ${i + 1}`, t] as const),
    ...(planned.comments ?? []).map((t, i) => [`comment ${i + 1}`, t] as const),
  ];
  const diff = addedByFile(planned.diff ?? "");
  const everything = [...texts, ...diff.map((d) => [d.file, d.lines.join("\n")] as const)];
  for (const [where, text] of everything)
    for (const f of scanText(text)) findings.push({ check: "secret", where, detail: `${f.rule}, line ${f.line}` });
  for (const [where, text] of everything)
    for (const [detail, re] of INSTRUCTIONS)
      if (re.test(text)) findings.push({ check: "agent-instruction", where, detail });
  for (const [where, text] of texts)
    for (const url of new Set(text.match(/https?:\/\/[^\s)>\]"'`]+/gi) ?? [])) {
      const host = hostOf(url);
      // A string that is not a URL (a scrubbed `https://<redacted>@host`) renders as no link.
      if (host && !allowed(host, hosts))
        findings.push({ check: "link", where, detail: `a link to ${host}, which is not allowlisted` });
    }
  for (const { file, lines } of diff) {
    const text = lines.join("\n");
    if (PIPE_TO_SHELL.test(text))
      findings.push({ check: "network-call", where: file, detail: "downloads a script and runs it" });
    if (!SCRIPT_FILE.test(file)) continue;
    if (NETWORK.test(text))
      findings.push({ check: "network-call", where: file, detail: "a new network call in a script" });
    if (INSTALL.test(text))
      findings.push({ check: "install-script", where: file, detail: "a new package install in a script" });
    if (LIFECYCLE.test(text))
      findings.push({ check: "install-script", where: file, detail: "a new install lifecycle script" });
  }
  return findings.length ? { verdict: "hold", findings } : { verdict: "pass" };
}

export class ScreenHeld extends Error {
  constructor(readonly findings: readonly Finding[]) {
    super(`held: ${findings.length} finding(s)`);
  }
}

export const describeFindings = (findings: readonly Finding[]): string =>
  findings.map((f) => `- ${f.check} in ${f.where}: ${f.detail}`).join("\n");

function check(planned: Planned, hosts: readonly string[]): void {
  const screen = screenWrites(planned, hosts);
  if (screen.verdict === "hold") throw new ScreenHeld(screen.findings);
}

// The tracker a run's steps get: an issue, a PR or a comment is screened before it is posted. A pull
// request is screened with the diff it carries.
export function screenScm<T extends ScmPort>(github: T, hosts: readonly string[], diff: () => Promise<string>): T {
  return Object.create(github, {
    createIssue: {
      value: async (repo: string, title: string, body: string, labels: string[]) => {
        check({ titles: [title], comments: [body] }, hosts);
        return github.createIssue(repo, title, body, labels);
      },
    },
    createPr: {
      value: async (opts: CreatePrOptions) => {
        check({ titles: [opts.title], comments: [opts.body], diff: await diff() }, hosts);
        return github.createPr(opts);
      },
    },
    commentIssue: {
      value: async (repo: string, n: number, body: string) => {
        check({ comments: [body] }, hosts);
        return github.commentIssue(repo, n, body);
      },
    },
  }) as T;
}
