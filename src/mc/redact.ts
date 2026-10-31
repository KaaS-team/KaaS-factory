// Every string a mission control adapter copies from a vendor passes through here before it lands in a
// row: credential shapes and the secrets this process resolved become "[redacted]".

const VALUE = "[A-Za-z0-9+/=._~-]{8,}";
const PARAMS = "token|access_token|key|api_key|secret|sig|signature|code|auth";

export const CREDENTIAL_TEXT: readonly RegExp[] = [
  /\/\/[^\s/@:]+:[^\s/@]+@/g,
  new RegExp(`\\b(Bearer|Basic)\\s+${VALUE}`, "gi"),
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  new RegExp(`[?&](${PARAMS})=[^&\\s#]*`, "gi"),
];

const MIN_KNOWN = 8;

export function redactText(s: string, known: readonly string[] = []): string {
  let out = s.normalize("NFKC");
  for (const re of CREDENTIAL_TEXT) out = out.replace(re, "[redacted]");
  for (const k of known) {
    const v = k.normalize("NFKC");
    if (v.length >= MIN_KNOWN) out = out.split(v).join("[redacted]");
  }
  return out;
}

export function redactRow<T>(row: T, known: readonly string[] = []): T {
  if (typeof row === "string") return redactText(row, known) as T;
  if (Array.isArray(row)) return row.map((v) => redactRow(v, known)) as T;
  if (row && typeof row === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = redactRow(v, known);
    return out as T;
  }
  return row;
}
