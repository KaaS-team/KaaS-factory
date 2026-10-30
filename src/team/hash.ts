// A short fingerprint of a resolved config, so two runs can say they used the same one.
import { createHash } from "node:crypto";

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v !== "object" || v === null) return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, canonical(o[k])]),
  );
}

// Reads nothing from the environment: a secret reaches the hash only as the variable name the
// caller put in values.
export function configHash(values: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(values)))
    .digest("hex")
    .slice(0, 12);
}
