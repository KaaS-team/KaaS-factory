// Commit sign-off modes (#366). Unset keeps today's output: one Signed-off-by, on commit-tree only.
export const SIGNOFF_MODES = ["human", "bot", "none"] as const;
export type SignoffMode = (typeof SIGNOFF_MODES)[number];

export interface Person {
  readonly name: string;
  readonly email: string;
}

export const AI_TRAILER = "Assisted-by: KaaS Factory";

// human: sign-off plus the requester as co-author. bot: the same plus the AI trailer. none: no trailers.
export function signoffTrailers(mode: SignoffMode, signer: Person, requester?: Person): string[] {
  if (mode === "none") return [];
  const out = [`Signed-off-by: ${signer.name} <${signer.email}>`];
  if (requester) out.push(`Co-authored-by: ${requester.name} <${requester.email}>`);
  if (mode === "bot") out.push(AI_TRAILER);
  return out;
}

export function withTrailers(args: string[], trailers: readonly string[]): string[] {
  const i = args.indexOf("-m");
  if (i < 0 || args[i + 1] === undefined || trailers.length === 0) return args;
  const out = [...args];
  out[i + 1] = `${args[i + 1]}\n\n${trailers.join("\n")}`;
  return out;
}

export function commitsProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["commits: expected an object"];
  const out: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("_")) continue;
    if (key !== "signoff") out.push(`commits.${key}: unknown key (allowed: signoff)`);
    else if (!(SIGNOFF_MODES as readonly unknown[]).includes(value))
      out.push(`commits.signoff: expected one of ${SIGNOFF_MODES.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return out;
}
