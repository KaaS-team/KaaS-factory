// Safe outputs: an agent stage reads and writes files in its worktree; only the runner's executor
// talks to the tracker or GitHub, with tokens the agent never sees. Any allow rule that would let
// an agent reach outward (a repo's agentCommands included) is dropped here, before claude sees it.

const OUTWARD = [
  /^gh(\s|$)/,
  /^hub(\s|$)/,
  /^git\s+(push|remote|send-email|credential)\b/,
  /^git\s+config\b.*\b(url|credential|remote)\./,
  /^(curl|wget|nc|ssh|scp|rsync)(\s|$)/,
  /^(npm|bun|pnpm|yarn)\s+publish\b/,
];

// The command a `Bash(...)` rule allows, or undefined for a non-shell rule.
const shellOf = (rule: string): string | undefined => /^Bash\((.*)\)$/.exec(rule)?.[1]?.trim();

export function isOutward(rule: string): boolean {
  const cmd = shellOf(rule);
  return cmd !== undefined && OUTWARD.some((re) => re.test(cmd));
}

export function safeRules(rules: readonly string[]): string[] {
  return rules.filter((r) => !isOutward(r));
}
