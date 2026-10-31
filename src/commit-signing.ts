// Commit signing (#357). Given a signing config, rewrite a `commit` or `commit-tree` argv so git signs
// it, and refuse to run when signing is required but the config cannot sign. The key is never logged.
export const SIGNING_FORMATS = ["ssh", "gpg"] as const;
export type SigningFormat = (typeof SIGNING_FORMATS)[number];

export interface SigningConfig {
  readonly format: SigningFormat;
  // ssh: path to a private key, a public key, or a `key::` literal. gpg: a key id.
  readonly key?: string;
  // true: a commit that cannot be signed is an error, never an unsigned commit.
  readonly required?: boolean;
}

export class SigningRequiredError extends Error {
  constructor(reason: string) {
    super(`commit signing is required but ${reason}; refusing to commit unsigned`);
    this.name = "SigningRequiredError";
  }
}

// `commit` and `commit-tree` both take -S; the -c pairs must precede the subcommand.
export function withSigning(args: string[], signing: SigningConfig | undefined): string[] {
  if (!signing) return args;
  const cmd = args[0];
  if (cmd !== "commit" && cmd !== "commit-tree") return args;
  const key = signing.key?.trim() ?? "";
  if (key === "") {
    if (signing.required) throw new SigningRequiredError("no signing key is configured");
    return args;
  }
  return [
    "-c",
    `gpg.format=${signing.format === "gpg" ? "openpgp" : "ssh"}`,
    "-c",
    `user.signingkey=${key}`,
    cmd,
    "-S",
    ...args.slice(1),
  ];
}

export function signingProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["commits.signing: expected an object"];
  const out: string[] = [];
  const o = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith("_")) continue;
    if (k === "format") {
      if (!(SIGNING_FORMATS as readonly unknown[]).includes(v))
        out.push(`commits.signing.format: expected one of ${SIGNING_FORMATS.join(", ")}`);
    } else if (k === "key") {
      if (typeof v !== "string" || v.trim() === "") out.push("commits.signing.key: expected a non-empty string");
    } else if (k === "required") {
      if (typeof v !== "boolean") out.push("commits.signing.required: expected a boolean");
    } else out.push(`commits.signing.${k}: unknown key (allowed: format, key, required)`);
  }
  if (o.format === undefined) out.push("commits.signing.format: required");
  return out;
}
