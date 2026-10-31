// `commits.signoff`: which trailers the runner's own commit-tree commits carry.
// Unset keeps the single Signed-off-by line, so existing repos see no change.
export const SIGNOFF_MODES = ["human", "bot", "none"] as const;
export type SignoffMode = (typeof SIGNOFF_MODES)[number];

export interface CommitsConfig {
  readonly signoff?: SignoffMode;
}

export const AI_TRAILER = "Assisted-by: kaas-factory";
export const BOT_SIGNER = { name: "kaas-factory", email: "factory@users.noreply.github.com" };

export interface Person {
  readonly name: string;
  readonly email: string;
}

export function commitsProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["commits: expected object"];
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.startsWith("_")) continue;
    if (k !== "signoff") out.push(`commits.${k}: unknown key (allowed: signoff)`);
    else if (!(SIGNOFF_MODES as readonly unknown[]).includes(v))
      out.push(`commits.signoff: expected one of ${SIGNOFF_MODES.join(", ")}, got ${JSON.stringify(v)}`);
  }
  return out;
}

export function signoffTrailers(mode: SignoffMode, committer: Person, requester?: Person): string[] {
  if (mode === "none") return [];
  const signer = mode === "bot" ? BOT_SIGNER : committer;
  const trailers = [`Signed-off-by: ${signer.name} <${signer.email}>`];
  if (requester) trailers.push(`Co-authored-by: ${requester.name} <${requester.email}>`);
  trailers.push(AI_TRAILER);
  return trailers;
}

export function applySignoff(args: string[], mode: SignoffMode, committer: Person, requester?: Person): string[] {
  const i = args.indexOf("-m");
  if (i < 0 || args[i + 1] === undefined) return args;
  const trailers = signoffTrailers(mode, committer, requester);
  if (trailers.length === 0) return args;
  const out = [...args];
  out[i + 1] = `${args[i + 1]}\n\n${trailers.join("\n")}`;
  return out;
}
